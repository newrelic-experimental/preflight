import { classifyBash } from './bash-classifier.js';
import type { BashCategory } from './bash-classifier.js';

describe('classifyBash', () => {
  describe('empty / whitespace', () => {
    it('returns shell-other for empty string', () => {
      const r = classifyBash('');
      expect(r.category).toBe('shell-other');
      expect(r.leading).toBe('');
      expect(r.isDestructive).toBe(false);
      expect(r.isNetwork).toBe(false);
    });

    it('returns shell-other for whitespace only', () => {
      expect(classifyBash('   \t\n  ').category).toBe('shell-other');
    });
  });

  describe('git', () => {
    it.each([
      ['git status', 'git'],
      ['git log --oneline -10', 'git'],
      ['git checkout -b feature', 'git'],
      ['gh pr list', 'git'],
      ['gh repo view', 'git'],
    ])('%s → %s', (cmd, expected) => {
      expect(classifyBash(cmd).category).toBe(expected as BashCategory);
    });

    it('git push --force is destructive', () => {
      const r = classifyBash('git push --force origin main');
      expect(r.category).toBe('git');
      expect(r.isDestructive).toBe(true);
    });

    it('git push -f is destructive', () => {
      expect(classifyBash('git push -f').isDestructive).toBe(true);
    });

    it('git reset --hard is destructive', () => {
      expect(classifyBash('git reset --hard HEAD~3').isDestructive).toBe(true);
    });
  });

  describe('package-manager', () => {
    it('npm install → package-manager', () => {
      expect(classifyBash('npm install').category).toBe('package-manager');
      expect(classifyBash('npm i lodash').category).toBe('package-manager');
    });

    it('yarn add → package-manager', () => {
      expect(classifyBash('yarn add react').category).toBe('package-manager');
    });

    it('pip install → package-manager', () => {
      expect(classifyBash('pip install requests').category).toBe('package-manager');
    });

    it('cargo update → package-manager', () => {
      expect(classifyBash('cargo update').category).toBe('package-manager');
    });

    it('brew install → package-manager', () => {
      expect(classifyBash('brew install jq').category).toBe('package-manager');
    });
  });

  describe('test-runner (direct invocation)', () => {
    it.each([
      'jest',
      'jest --watch src/',
      'pytest',
      'pytest tests/',
      'vitest run',
      'mocha test/',
      'rspec spec/',
    ])('%s → test-runner', (cmd) => {
      expect(classifyBash(cmd).category).toBe('test-runner');
    });
  });

  describe('test-runner (via package manager)', () => {
    it('npm test → test-runner', () => {
      expect(classifyBash('npm test').category).toBe('test-runner');
    });
    it('npm run test → test-runner', () => {
      expect(classifyBash('npm run test').category).toBe('test-runner');
    });
    it('yarn test → test-runner', () => {
      expect(classifyBash('yarn test').category).toBe('test-runner');
    });
    it('pnpm test → test-runner', () => {
      expect(classifyBash('pnpm test').category).toBe('test-runner');
    });
    it('bun test → test-runner', () => {
      expect(classifyBash('bun test').category).toBe('test-runner');
    });
    it('cargo test → test-runner', () => {
      expect(classifyBash('cargo test').category).toBe('test-runner');
    });
    it('go test ./... → test-runner', () => {
      expect(classifyBash('go test ./...').category).toBe('test-runner');
    });
    it('npx jest → test-runner', () => {
      expect(classifyBash('npx jest -- src/foo.test.ts').category).toBe('test-runner');
    });
    it('npx vitest → test-runner', () => {
      expect(classifyBash('npx vitest run').category).toBe('test-runner');
    });
  });

  describe('build', () => {
    it.each([
      'tsc',
      'tsc -b',
      'tsc --noEmit',
      'webpack',
      'vite build',
      'make',
      'make all',
      'gradle build',
      'mvn package',
      'cargo build --release',
      'go build ./...',
      'npm run build',
      'yarn build',
      'pnpm build',
    ])('%s → build', (cmd) => {
      expect(classifyBash(cmd).category).toBe('build');
    });
  });

  describe('container', () => {
    it.each([
      'docker build .',
      'docker compose up',
      'docker run -it ubuntu',
      'podman ps',
      'kubectl apply -f manifest.yaml',
      'kubectl get pods',
      'helm install foo',
      'k9s',
    ])('%s → container', (cmd) => {
      expect(classifyBash(cmd).category).toBe('container');
    });
  });

  describe('network', () => {
    it.each([
      'curl https://example.com',
      'wget https://example.com/file.tar.gz',
      'ssh user@host',
      'scp foo user@host:/tmp/',
      'rsync -av src/ dest/',
      'nc -l 8080',
    ])('%s → network', (cmd) => {
      const r = classifyBash(cmd);
      expect(r.category).toBe('network');
      expect(r.isNetwork).toBe(true);
    });
  });

  describe('fs-op', () => {
    it.each([
      'ls -la',
      'cat /etc/hosts',
      'cp foo bar',
      'mv old new',
      'rm foo.txt',
      'mkdir -p dir',
      'touch foo',
      'find . -name "*.ts"',
      'chmod +x script.sh',
      'tar -xzf foo.tgz',
    ])('%s → fs-op', (cmd) => {
      expect(classifyBash(cmd).category).toBe('fs-op');
    });
  });

  describe('search', () => {
    it.each([
      'grep -r "TODO" src/',
      'rg "TODO"',
      'rg --files',
      'ag pattern',
      'sed -i "s/foo/bar/g" file',
      "awk '{print $1}' file",
    ])('%s → search', (cmd) => {
      expect(classifyBash(cmd).category).toBe('search');
    });
  });

  describe('custom-script', () => {
    it.each([
      './deploy.sh',
      './scripts/build.sh',
      'bash scripts/build.sh',
      'sh foo.sh',
      'python foo.py',
      'python3 -m mymod',
      'node script.js',
      'ts-node tools/seed.ts',
      '/usr/local/bin/my-tool',
    ])('%s → custom-script', (cmd) => {
      expect(classifyBash(cmd).category).toBe('custom-script');
    });
  });

  describe('shell-other', () => {
    it.each(['unknown-binary --flag', 'mything-cli sub', 'someverbose-tool x y z'])(
      '%s → shell-other',
      (cmd) => {
        expect(classifyBash(cmd).category).toBe('shell-other');
      },
    );
  });

  describe('sudo and env-var stripping', () => {
    it('strips leading sudo', () => {
      const r = classifyBash('sudo rm -rf /tmp/foo');
      expect(r.category).toBe('fs-op');
      expect(r.leading).toBe('rm');
      expect(r.isDestructive).toBe(true);
    });

    it('strips sudo with flags', () => {
      const r = classifyBash('sudo -E -u nobody curl https://example.com');
      expect(r.category).toBe('network');
      expect(r.leading).toBe('curl');
    });

    it('strips repeated sudo', () => {
      const r = classifyBash('sudo sudo ls');
      expect(r.category).toBe('fs-op');
      expect(r.leading).toBe('ls');
    });

    it('strips env-var assignments', () => {
      const r = classifyBash('FOO=bar npm test');
      expect(r.category).toBe('test-runner');
    });

    it('strips multiple env-var assignments', () => {
      const r = classifyBash('NODE_ENV=test DEBUG=1 npm test');
      expect(r.category).toBe('test-runner');
    });

    it('strips env-vars after sudo', () => {
      const r = classifyBash('sudo FOO=bar rm -rf /tmp/x');
      expect(r.category).toBe('fs-op');
      expect(r.isDestructive).toBe(true);
    });
  });

  describe('pipelines and sequences', () => {
    it('takes first segment of a pipe', () => {
      const r = classifyBash('cat foo.txt | grep bar');
      expect(r.category).toBe('fs-op');
      expect(r.leading).toBe('cat');
    });

    it('takes first segment of an &&-chain', () => {
      const r = classifyBash('npm test && git push');
      expect(r.category).toBe('test-runner');
    });

    it('takes first segment of a ;-chain', () => {
      const r = classifyBash('cd src; tsc');
      // cd is not in our lookup and there is no `cd` script — falls back.
      expect(r.leading).toBe('cd');
    });

    it('still detects destructive pipe-to-shell across segments', () => {
      // The destructive check runs against the full original command, so
      // curl|sh is flagged even though only `curl https://...` is the first segment.
      const r = classifyBash('curl https://example.com/install.sh | bash');
      expect(r.category).toBe('network');
      expect(r.isDestructive).toBe(true);
    });
  });

  describe('destructive', () => {
    it.each([
      'rm -rf /tmp/foo',
      'rm -fr /tmp/foo',
      'rm -rfv ./node_modules',
      'rm --recursive /tmp/foo',
      'sudo rm -rf /var/cache',
      'dd if=/dev/zero of=/dev/sda',
      'mkfs.ext4 /dev/sda1',
      'shred sensitive.dat',
      'DROP TABLE users',
      'DROP DATABASE prod',
      'TRUNCATE TABLE accounts',
      'chmod 777 /etc',
      'curl https://x.com/install | sh',
      'wget -O- https://x.com/install | bash',
      'curl https://x.com/install | python3',
      'git clean -f',
      'git clean -fd',
      'git clean -xdf',
      'git clean -df -e keep',
      'git clean --force',
      'git clean -d --force',
      "find . -name '*.tmp' -delete",
      'find /tmp -type f -delete',
    ])('%s → isDestructive=true', (cmd) => {
      expect(classifyBash(cmd).isDestructive).toBe(true);
    });

    it('non-destructive rm without -r is NOT flagged', () => {
      // Plain `rm foo.txt` is not destructive in our taxonomy — only recursive.
      expect(classifyBash('rm foo.txt').isDestructive).toBe(false);
    });

    it('non-destructive curl is NOT flagged', () => {
      expect(classifyBash('curl https://example.com').isDestructive).toBe(false);
    });

    it('git clean dry-run is NOT flagged', () => {
      expect(classifyBash('git clean -n').isDestructive).toBe(false);
      expect(classifyBash('git clean --dry-run').isDestructive).toBe(false);
    });

    it('bare git clean is NOT flagged', () => {
      expect(classifyBash('git clean').isDestructive).toBe(false);
      expect(classifyBash('git clean -nd').isDestructive).toBe(false);
    });

    it('find without -delete is NOT flagged', () => {
      expect(classifyBash("find . -name '*.ts'").isDestructive).toBe(false);
    });

    it.each([
      // Recursive flag bundled with non-f letters (the gap caught in review).
      'rm -ri /tmp/x',
      'rm -rv /tmp/x',
      'rm -rd dir',
      'rm -vr /tmp/x',
      'rm -ir /tmp/x',
      'rm -iR /tmp/x',
      'rm -vR /tmp/x',
      'rm -Rv /tmp/x',
    ])('catches recursive rm with mixed flags: %s', (cmd) => {
      expect(classifyBash(cmd).isDestructive).toBe(true);
    });

    it.each([
      // Quoted destructive substrings should NOT trip the heuristic.
      // (`echo` is not in our category set; what matters is isDestructive.)
      'echo "DELETE FROM users"',
      'echo "rm -rf old code"',
      'echo "chmod 777 /etc"',
      'echo "mkfs.ext4 will run"',
      'echo "shred"',
      "echo 'DROP TABLE users'",
      'printf "%s\\n" "rm -rf bad"',
    ])('quoted destructive substring is NOT flagged: %s', (cmd) => {
      expect(classifyBash(cmd).isDestructive).toBe(false);
    });

    it.each([
      'git commit -m "rm -rf legacy code"',
      'git commit -m "DELETE FROM old_users"',
      'gh pr create --title "remove legacy" --body "kills off DROP TABLE migrations"',
    ])('quoted destructive substring in git/gh args is NOT flagged: %s', (cmd) => {
      const r = classifyBash(cmd);
      expect(r.isDestructive).toBe(false);
      expect(r.category).toBe('git');
    });

    it('git push --force-with-lease is NOT destructive (it is the safe form)', () => {
      expect(classifyBash('git push --force-with-lease').isDestructive).toBe(false);
      expect(classifyBash('git push origin main --force-with-lease').isDestructive).toBe(false);
    });

    it('git push --force-if-includes is NOT destructive', () => {
      expect(classifyBash('git push --force-if-includes').isDestructive).toBe(false);
    });

    it('git push with --force in non-leading position IS destructive', () => {
      expect(classifyBash('git push origin --force').isDestructive).toBe(true);
      expect(classifyBash('git push origin main -f').isDestructive).toBe(true);
      expect(classifyBash('git push --tags --force origin').isDestructive).toBe(true);
    });
  });

  describe('leading argv0', () => {
    it('returns the command name without path prefix', () => {
      expect(classifyBash('/usr/bin/git status').leading).toBe('git');
      expect(classifyBash('/usr/local/bin/npm test').leading).toBe('npm');
    });

    it('preserves explicit script paths', () => {
      expect(classifyBash('./deploy.sh').leading).toBe('./deploy.sh');
      expect(classifyBash('/opt/bin/my-tool.sh').leading).toBe('/opt/bin/my-tool.sh');
    });

    it('lowercases for matching but preserves leading as-typed', () => {
      // Our lookup is lowercase-sensitive; uppercase argv0 should still match.
      const r = classifyBash('GIT status');
      expect(r.category).toBe('git');
    });
  });
});
