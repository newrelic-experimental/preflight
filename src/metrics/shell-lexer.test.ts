import { describe, expect, it } from '@jest/globals';

import { readShell } from './shell-lexer.js';

describe('readShell heredoc text', () => {
  it.each([
    ['a closed heredoc', "cat <<'EOF'\ngit push\nEOF\ngit log", "cat <<'EOF'\ngit log", false],
    [
      'a heredoc inside "$( … )"',
      'git commit -m "$(cat <<\'EOF\'\nfix: git push\nEOF\n)" && git push',
      'git commit -m "$(cat <<\'EOF\'\n)" && git push',
      false,
    ],
    ['a <<- heredoc', 'cat <<-EOF\n\tgit push\n\tEOF\ngit log', 'cat <<-EOF\ngit log', false],
    [
      'a heredoc with CRLF line ends',
      'cat <<EOF\r\ngit push\r\nEOF\r\ngit log',
      'cat <<EOF\r\ngit log',
      false,
    ],
    [
      'an inline script body',
      "python3 - <<'PY'\ngit push --force\nPY\necho done",
      "python3 - <<'PY'\necho done",
      false,
    ],
    ['a here-string', 'grep -q x <<<"$(gh pr view 1)"\ngit push', null, false],
    ['a double-quoted <<', 'gh pr comment 1 --body "see <<X"\ngit push', null, true],
    ['a single-quoted <<', "echo 'a <<B'\ngit push", null, true],
    ['a quoted "<<EOF"', 'echo "<<EOF"\ngit push', null, true],
    ['a << in a comment with an apostrophe', "# don't <<X\ngit push", null, true],
    ['a << before a number', 'echo $((1<<2))\ngit push', null, false],
    ['an escaped <', 'cat \\<<EOF\ngit push', null, false],
    ['no heredoc', 'git push origin main', null, false],
    [
      'a quoted << before a real heredoc',
      'echo "see <<X" && cat <<EOF\ngit push\nEOF\ngit log',
      'echo "see <<X" && cat <<EOF\ngit log',
      true,
    ],
    [
      'a quoted <<EOF that a real heredoc closes',
      'gh pr merge 1 --body "see <<EOF"\ngh pr comment 1 <<\'EOF\'\nDone.\nEOF',
      'gh pr merge 1 --body "see <<EOF"',
      true,
    ],
  ])('reads %s and reports no unclosed heredoc', (_label, command, text, readingsDiffer) => {
    expect(readShell(command)).toMatchObject({
      text: text ?? command,
      unclosed: false,
      readingsDiffer,
    });
  });

  it.each([
    ['a heredoc whose terminator never comes', 'cat <<EOF\ngit log\n', 'cat <<EOF', false],
    ['an unquoted << in arithmetic', 'echo $((1<<N))\ngit push', 'echo $((1<<N))', false],
    ['a quoted << whose quote never closes', 'echo "see <<X\ngit push', 'echo "see <<X', true],
    [
      'a <<- terminator indented with spaces',
      'cat <<-EOF\n  git push\n  EOF\ngit log',
      'cat <<-EOF',
      false,
    ],
    [
      'a terminator with a trailing space',
      'cat <<EOF\ngit push\nEOF \ngit log',
      'cat <<EOF',
      false,
    ],
  ])(
    'drops the lines after %s and reports it unclosed',
    (_label, command, text, readingsDiffer) => {
      expect(readShell(command)).toMatchObject({ text, unclosed: true, readingsDiffer });
    },
  );

  it('starts a heredoc body after a backslash-newline joins the introducing line', () => {
    expect(readShell('cat <<EOF \\\n| grep x\ngit push\nEOF\ngit log')).toEqual({
      text: 'cat <<EOF \\\n| grep x\ngit log',
      segments: ['cat <<EOF ', ' grep x', 'git log'],
      operators: ['|', '\n'],
      unclosed: false,
      readingsDiffer: false,
      balanced: true,
    });
  });
});

describe('readShell segments', () => {
  it('splits on &&, ;, |, and newline', () => {
    expect(readShell('a && b; c | d\ne').segments).toEqual(['a ', ' b', ' c ', ' d', 'e']);
  });

  it('treats a newline as a separator, not just &&/;/|', () => {
    expect(readShell('git commit -m x\ngh pr create').segments).toEqual([
      'git commit -m x',
      'gh pr create',
    ]);
  });

  it('does not split on an operator inside quotes', () => {
    expect(readShell(`git commit -m "a; b && c" && echo 'x | y'`).segments).toEqual([
      'git commit -m "a; b && c" ',
      " echo 'x | y'",
    ]);
  });

  it('joins a backslash-newline and continues a line that ends in ||, && or |', () => {
    expect(readShell('git commit \\\n  -m x &&\n  git push ||\n\n  echo failed').segments).toEqual([
      'git commit   -m x ',
      '  git push ',
      '  echo failed',
    ]);
  });

  it('splits on a background & but not on a redirection', () => {
    expect(readShell('git fetch & git status 2>&1 >/dev/null &>/dev/null').segments).toEqual([
      'git fetch ',
      ' git status 2>&1 >/dev/null &>/dev/null',
    ]);
  });

  it('splits the line after a heredoc body from the line that introduced it', () => {
    expect(
      readShell("cat > body.md <<'EOF'\nsome text\nEOF\ngh pr create --body-file body.md"),
    ).toMatchObject({
      segments: ["cat > body.md <<'EOF'", 'gh pr create --body-file body.md'],
      operators: ['\n'],
    });
  });

  it('continues past a heredoc body after a trailing &&', () => {
    expect(readShell("gh pr merge 1 <<'EOF' &&\nMerged.\nEOF\n  git pull")).toMatchObject({
      segments: ["gh pr merge 1 <<'EOF' ", '  git pull'],
      operators: ['&&'],
    });
  });

  it('skips a comment line without opening the quote in it', () => {
    expect(readShell("git add -A\n# Claude's fix\ngit commit -m x && git push")).toMatchObject({
      segments: ['git add -A', '', 'git commit -m x ', ' git push'],
      operators: ['\n', '\n', '&&'],
      balanced: true,
    });
  });

  it('does not split on an operator inside a trailing comment', () => {
    expect(readShell('gh pr checks 5 # then && gh pr merge 5')).toMatchObject({
      segments: ['gh pr checks 5 '],
      operators: [],
      balanced: true,
    });
  });

  it('starts a comment after an operator or `(`, and ends it at the newline past a backslash', () => {
    expect(readShell('a;# x && y\n(# z\nb) # w \\\nc')).toMatchObject({
      segments: ['a', '', '(', 'b) ', 'c'],
      operators: [';', '\n', '\n', '\n'],
      balanced: true,
    });
  });

  it('starts a continued segment at its command, past comment lines', () => {
    expect(readShell('a &&\n  # check first\n  git push')).toMatchObject({
      segments: ['a ', '  git push'],
      operators: ['&&'],
      balanced: true,
    });
  });

  it('does not start a comment at a # inside a word or quotes', () => {
    expect(
      readShell(
        `git commit -m "fix #12; it's done" && echo issue#12 \${#arr} $# a\\ #b 'c #d' && git push`,
      ),
    ).toMatchObject({
      segments: [
        `git commit -m "fix #12; it's done" `,
        ` echo issue#12 \${#arr} $# a\\ #b 'c #d' `,
        ' git push',
      ],
      operators: ['&&', '&&'],
      balanced: true,
    });
  });

  it('reports `|&` as `|`', () => {
    expect(readShell('git push 2>&1 |& tee log & wait')).toMatchObject({
      segments: ['git push 2>&1 ', ' tee log ', ' wait'],
      operators: ['|', '&'],
      balanced: true,
    });
  });

  it('splits on every operator, quoted or commented, when a quote never closes', () => {
    expect(readShell("echo $'it\\'s done' # note && git commit -m 'a; b'")).toMatchObject({
      segments: ["echo $'it\\'s done' # note ", " git commit -m 'a", " b'"],
      operators: ['&&', ';'],
      balanced: false,
    });
  });

  it('splits on every operator when a `( … )` group never closes', () => {
    expect(readShell('echo "a; b" && (git push')).toMatchObject({
      segments: ['echo "a', ' b" ', ' (git push'],
      operators: [';', '&&'],
      balanced: false,
    });
  });
});

// Shapes that the old heredoc scanner and the old chain splitter read
// differently, so the text they classified and the segments they split did
// not agree.
describe('readShell where two scans used to disagree', () => {
  it('reads a quote inside "$( … )" as nested, so its operators do not split', () => {
    expect(readShell('git commit -m "$(echo "fix; git push")" && git pull')).toEqual({
      text: 'git commit -m "$(echo "fix; git push")" && git pull',
      segments: ['git commit -m "$(echo "fix; git push")" ', ' git pull'],
      operators: ['&&'],
      unclosed: false,
      readingsDiffer: false,
      balanced: true,
    });
  });

  it('reads a nested quote and a heredoc in the same command', () => {
    expect(
      readShell(
        'gh pr merge 42 --body "$(echo "a; b")" && cat <<\'EOF\'\ngit push --force\nEOF\ngit pull',
      ),
    ).toEqual({
      text: 'gh pr merge 42 --body "$(echo "a; b")" && cat <<\'EOF\'\ngit pull',
      segments: ['gh pr merge 42 --body "$(echo "a; b")" ', " cat <<'EOF'", 'git pull'],
      operators: ['&&', '\n'],
      unclosed: false,
      readingsDiffer: false,
      balanced: true,
    });
  });

  it('reads a comment inside "$( … )" as a comment', () => {
    expect(readShell('echo "$(git log -1 # it\'s\n)" && cat <<EOF\ngit push\nEOF')).toEqual({
      text: 'echo "$(git log -1 # it\'s\n)" && cat <<EOF',
      segments: ['echo "$(git log -1 \n)" ', ' cat <<EOF'],
      operators: ['&&'],
      unclosed: false,
      readingsDiffer: false,
      balanced: true,
    });
  });

  it('reads a # right after a carriage return as part of the word', () => {
    expect(readShell("echo x\r#' <<X\ngit push")).toEqual({
      text: "echo x\r#' <<X",
      segments: ["echo x\r#' <<X"],
      operators: [],
      unclosed: true,
      readingsDiffer: true,
      balanced: false,
    });
  });

  it('reads a backslash-escaped << as no heredoc in every reading', () => {
    expect(readShell('echo "x" \\<<EOF && gh pr merge 5\ngit push')).toEqual({
      text: 'echo "x" \\<<EOF && gh pr merge 5\ngit push',
      segments: ['echo "x" \\<<EOF ', ' gh pr merge 5', 'git push'],
      operators: ['&&', '\n'],
      unclosed: false,
      readingsDiffer: false,
      balanced: true,
    });
  });
});
