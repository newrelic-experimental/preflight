import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { redactSensitive } from './config.js';
import { classifyBash } from './hooks/bash-classifier.js';
import { processHook, redact } from './hooks/collector-script.js';
import { parseToolSpecificFields } from './hooks/tool-parsers.js';
import { REDACTION_PATTERNS } from './redaction-patterns.js';

const AWS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const PROSE = "Don't paste this: ";

// [command, ...each part that is stored as [REDACTED]]. A command with no parts is stored as is.
type Row = [string, ...string[]];
const stored = ([command, ...parts]: Row): string =>
  parts.reduce((text, part) => text.replace(part, '[REDACTED]'), command);

const KEEPS_COMMAND: Row[] = [
  ['curl --token S3CRET9;rm -rf /tmp/x', '--token S3CRET9'],
  ['curl --token "S3CRET9";rm -rf /tmp/x', '--token "S3CRET9"'],
  ['curl --token S3CRET9|sh', '--token S3CRET9'],
  ['(curl --token S3CRET9) ; rm -rf /tmp/x', '--token S3CRET9'],
  ['echo `curl --token S3CRET9`; rm -rf /tmp/x', '--token S3CRET9'],
  ['API_KEY=abc;rm -rf /tmp/x', 'API_KEY=abc'],
  ['bash -c "TOKEN="S3\\\\CRET9" x" ; rm -rf /tmp/x', 'S3', 'CRET9'],
  ['curl --token a\\"b ; rm -rf /tmp/x ; echo "ok"', '--token a\\"b'],
  ['echo "API_KEY=sk123" >> .env && rm -rf /tmp/x && echo "done now"', 'API_KEY=sk123'],
  ["echo 'API_KEY=sk123' >> .env && rm -rf /tmp/x && echo 'done now'", 'API_KEY=sk123'],
  ['bash -c "curl --token abc" ; rm -rf /tmp/x ; echo "a b"c', '--token abc'],
  ['curl -H "X-Auth-Token: abc123" ; rm -rf /tmp/x', 'X-Auth-Token: abc123'],
  ['echo "PASSWORD:" ; rm -rf /tmp/x'],
  [`aws_secret_access_key "${AWS_KEY}" ; rm -rf /tmp/x`, `aws_secret_access_key "${AWS_KEY}"`],
  ['curl --token $(rm -rf /tmp/x)', '--token $'],
  ['curl --token S3CRET9>/dev/sda', '--token S3CRET9'],
  ['curl --token "abc && rm -rf /tmp/x', '--token "abc'],
  ['curl --token my\\ S3CRET9"x ; rm -rf /tmp/x', '--token my\\ S3CRET9"x'],
  ["curl --token 'a\\' ; rm -rf /tmp/x ; echo 'b", "--token 'a\\'"],
  ["curl --token $HOME'a\\' ; rm -rf /tmp/x ; echo '", "--token $HOME'a\\'"],
  ['echo "TOKEN=a\'b" ; rm -rf /tmp/x', 'TOKEN=a', 'b'],
  ["echo $'TOKEN=abc' ; rm -rf /tmp/x ; echo 'a b'c", 'TOKEN=abc'],
  ["echo 'x' && curl --token a'b c'd && rm -rf /tmp/x", "--token a'b c'd"],
  ['echo "x" && curl --token "a b" && rm -rf /tmp/x', '--token "a b"'],
  ["# n\necho 'TOKEN=abc' ; rm -rf /tmp/x ; echo 'a b'c", 'TOKEN=abc'],
  ["echo a#b 'TOKEN=abc' ; rm -rf /tmp/x ; echo 'a b'c", 'TOKEN=abc'],
  ['# set --token "a\nrm -rf /tmp/x ; echo "b', '--token "a'],
  ["it's --password 'abc ; rm -rf /tmp/x ; echo 'x"],
  [`curl --token "${'a '.repeat(2100)}" ; rm -rf /tmp/x`],
  ['curl -u user:pass x;rm -rf /tmp/x', '-u user:pass'],
  ["curl -u 'a b' x && rm -rf /tmp/x", "-u 'a b'"],
  ['docker login -p s3cretpw x;rm -rf /tmp/x', '-p s3cretpw'],
  ['sshpass -p hunter2 ssh h && rm -rf /tmp/x', '-p hunter2'],
  ['redis-cli -a s3cretpw ping;rm -rf /tmp/x', '-a s3cretpw'],
  ['http x "X-Api-Key: S3 CRET9" ; rm -rf /tmp/x', ' S3 CRET9'],
  ["echo 'a'X-Api-Key:b c ; rm -rf /tmp/x"],
  ["echo 'X-Api-Key:\"S3'CRET9 ; rm -rf /tmp/x", 'S3'],
  ['curl -HX-Api-Key:S3CRET9;rm -rf /tmp/x', 'X-Api-Key:S3CRET9'],
  ['echo "$(curl -u "me:S3 CRET9" x)" ; rm -rf /tmp/x', '-u "me:S3 CRET9"'],
  ["curl -u\\\n  'me:S3 CRET9' x && rm -rf /tmp/x", "-u\\\n  'me:S3 CRET9'"],
  ["Don't paste: curl -u 'a ; rm -rf /tmp/x ; echo 'x"],
  ["Don't paste: curl -u 'a\nrm -rf /tmp/x' y"],
  ["Don't paste: curl -u 'me:a #b' x\nrm -rf /tmp/x"],
  ["Don't paste: curl -H 'X-Api-Key: a #b' x\nrm -rf /tmp/x", 'X-Api-Key: a'],
  ["Don't paste: curl -H 'X-Api-Key: a b'';rm -rf /tmp/x", 'X-Api-Key: a b'],
  ['curl -H \'X-Api-Key: a b\'"S3 CRET9"&&rm -rf /tmp/x', 'X-Api-Key: a b', '"S3 CRET9"'],
  ["Don't paste: curl -H 'X-Api-Key: a b'x'; rm -rf /tmp/x ; echo 'y", 'X-Api-Key: a b', 'x'],
  ["Don't paste: http x 'X-Api-Key: a b'\"S3\"'|rm -rf /tmp/x", ' a b', '"S3"'],
  ['http x X-Api-Key:\'a b\'"S3";rm -rf /tmp/x', 'a b', '"S3"'],
  ['bash -c "curl -sH \'X-Api-Key:S3\'\'Z9\tq"d"e\'"f\'g\\"h" x" ; rm -rf /tmp/x', 'X-Api-Key:S3'],
  [
    'bash -c "(curl -sH \'X-Api-Key: S3 Z9\'Q7\\(d\\"e$\'f;g"h\'\\\n"i\\"j" x")rm -rf /tmp/x',
    'X-Api-Key: S3 Z9',
    'Q7',
  ],
  ['curl -sHX-Api-Key:S3CRET9;rm -rf /tmp/x', 'X-Api-Key:S3CRET9'],
  [`bash -c "docker login -p\\\n S3\\"CRET9"'" ; rm -rf /tmp/x'`, '-p\\\n S3', 'CRET9'],
  [`bash -c "docker login -p S3\\"CRET9"'" ; rm -rf /tmp/x'`, '-p S3', 'CRET9'],
  [`bash -c "docker login -pS3\\"CRET9"'" ; rm -rf /tmp/x'`, '-pS3', 'CRET9'],
  [`bash -c "curl -u S3\\"CRET9"'" ; rm -rf /tmp/x'`, '-u S3', 'CRET9'],
  [`bash -c "curl --user=S3\\"CRET9"'" ; rm -rf /tmp/x'`, '--user=S3', 'CRET9'],
  [`bash -c "curl --token S3\\"CRET9"'" ; rm -rf /tmp/x'`, '--token S3', 'CRET9'],
  [`bash -c "curl --token S3'CRET9""' ; rm -rf /tmp/x"`, '--token S3', 'CRET9'],
  [`bash -c "echo \\"--token S3\\" ; rm -rf /tmp/x"`, '--token S3'],
  [`bash -c "API_KEY=S3\\"CRET9"'" ; rm -rf /tmp/x'`, 'API_KEY=S3', 'CRET9'],
  [`bash -c "mysql -pS3\\"CRET9"'" ; rm -rf /tmp/x'`, '-pS3', 'CRET9'],
  [`bash -c "curl -H X-Api-Key:S3\\"CRET9"'" ; rm -rf /tmp/x'`, 'X-Api-Key:S3', 'CRET9'],
  [`bash -c "curl --token S3\\"CRET9\\" x" ; rm -rf /tmp/x`, '--token S3\\"CRET9\\"'],
  [`bash -c "docker login -p S3\\\\\\"CRET9 x ; rm -rf /tmp/x"`, '-p S3\\\\\\"CRET9'],
  [`bash -c "curl -u 'S3 CRET9' x ; rm -rf /tmp/x"`, "-u 'S3 CRET9'"],
  [`bash -c "TOKEN=S3\\"CRET9 x"'" ; rm -rf /tmp/x'`, 'TOKEN=S3', 'CRET9'],
  [`bash -c "curl -u S3\\"$'CRET9"'" ; rm -rf /tmp/x'`, '-u S3', 'CRET9'],
  [`bash -c "curl -u S3\\\\ Q1\\"CRET9"'" ; rm -rf /tmp/x'`, '-u S3', ' Q1', 'CRET9'],
  [`bash -c "curl -u "Z1"S3\\"CRET9"'" ; rm -rf /tmp/x'`, '-u ', 'Z1', 'S3', 'CRET9'],
  [`bash -c "mysql \\b-pS3\\"CRET9"'" ; rm -rf /tmp/x'`, '-pS3', 'CRET9'],
];

const REDACTS: Row[] = [
  [`bash -c "curl -H X-Api-Key:S3'Q1'C9"Z2"a\\"b" x"`, "X-Api-Key:S3'Q1'C9"],
  [`Don't paste: curl --token S3"CRET9 x`, '--token S3"CRET9'],
  [`Bob's box: curl -H X-Api-Key:'S3 CRET9'"a'b" x`, 'S3 CRET9'],
  [`bash -c "curl -H 'X-Api-Key: S3\\"CRET9' x"`, 'X-Api-Key: S3\\"CRET9'],
  ['npm run deploy -- --token secret123', '--token secret123'],
  ['mysql -u root -psecret123', '-psecret123'],
  ['curl -H "X-Api-Key secret123" https://api.example.com', 'X-Api-Key secret123'],
  ['curl --token="my secret" x', 'token="my secret"'],
  ["tool --password='a b S3CRET9' x", "password='a b S3CRET9'"],
  ['API_KEY="a b S3CRET9" x', 'API_KEY="a b S3CRET9"'],
  ['mysql -u root --password=\nrm -rf /tmp/x', 'password=\nrm'],
  ['PASSWORD\n= S3CRET9 x', 'PASSWORD\n= S3CRET9'],
  ['curl --token \\\n  S3CRET9 x', '--token \\\n  S3CRET9'],
  ['curl -H \\\n    "X-Api-Key: S3CRET9" x', 'X-Api-Key: S3CRET9'],
  ['curl --token "sec\\"S3CRET9" x', '--token "sec\\"S3CRET9"'],
  ['curl --token my\\ secret x', '--token my\\ secret'],
  ['API_KEY=my\\ secret x', 'API_KEY=my\\ secret'],
  ['--token=a\\ b S3CRET9', 'token=a\\ b'],
  ['curl --token "a\nS3CRET9" x', '--token "a\nS3CRET9"'],
  ["curl --token 'a\nS3CRET9' x", "--token 'a\nS3CRET9'"],
  ['curl -H "X-Auth-Token: abc123" x', 'X-Auth-Token: abc123'],
  ['mysql -psecret1 -psecret2', '-psecret1', '-psecret2'],
  ['tool --a-b-c-d-token abc123 x', '--a-b-c-d-token abc123'],
  [
    JSON.stringify(`aws_secret_access_key "${AWS_KEY}" x`),
    `aws_secret_access_key \\"${AWS_KEY}\\"`,
  ],
  ['curl --token S3\\\r\nCRET9 x', '--token S3\\\r\nCRET9'],
  ['mysql -u root -pS3CRET9<dump.sql', '-pS3CRET9'],
  ['mysql -h db 2>/dev/null -pS3CRET9 shop', '-pS3CRET9'],
  ['mysql -h db 2>&1 -pS3CRET9 shop', '-pS3CRET9'],
  ['mysql -h db &>/dev/null -pS3CRET9 shop', '-pS3CRET9'],
  ['curl -H \\"X-Api-Key: a"b c" x ; rm -rf /tmp/x', 'X-Api-Key: a"b c"'],
  [`aws_secret_access_key '${AWS_KEY}' x`, `aws_secret_access_key '${AWS_KEY}'`],
  ['PGPASSWORD=S3CRET9 psql -h db', 'PASSWORD=S3CRET9'],
  [`bash -c "TOKEN="S3$'CR\\'ET9' --token 'a b' x"`, 'S3', 'CR', 'ET9', "--token 'a b'"],
  ['curl --token "abc && curl --password x\\ny', '--token "abc', '--password x\\ny'],
  ["# don't\ncurl --token 'S3CRET9' x", "--token 'S3CRET9'"],
  ["Don't pass --password 'hunter2' here", "--password 'hunter2'"],
  ["echo o'clock && mysql -u root -p'S3CRET9' shop\nls", "-p'S3CRET9'"],
  ["echo o'clock && tool --password 'S3'\"CR\"'ET9' x", "--password 'S3'\"CR\"'ET9'"],
  ["cat <<'EOF' > notes.md\nit's done\nEOF\ncurl --token 'S3CRET9' x", "--token 'S3CRET9'"],
  ['# --token \nabc\nls'],
  ['echo \\" && curl --token "a b" && rm -rf /tmp/x', '--token "a b"'],
  ["echo $'it\\'s' && curl --token a'b c'd x", "--token a'b c'd"],
  [JSON.stringify('curl --token S3CRET9\nrm -rf /tmp/x'), '--token S3CRET9'],
  [JSON.stringify('curl --token S3CRET9\trm -rf /tmp/x'), '--token S3CRET9'],
  [JSON.stringify('curl --token S3CRET9\r\nrm -rf /tmp/x'), '--token S3CRET9'],
  [JSON.stringify({ command: 'curl --token S3CRET9\\' }), '--token S3CRET9\\\\'],
  [`curl --token "${'a'.repeat(4096)}" x`, `--token "${'a'.repeat(4096)}"`],
  [`curl --token "${'a'.repeat(4097)}" x`],
  [`curl --token ab$c"${'a'.repeat(4097)}" x`, '--token ab$c'],
  ['docker run -p 8080:80 nginx'],
  ['git log -p'],
  ['tool --password-file x'],
  ['ls -p'],
  ['grep -p foo file.txt'],
  ['ssh -p 2222 host'],
  ['cp -p a b'],
  ['some-cli --token \\\n  --verbose'],
  ['some-cli --token \\\n--verbose'],
  ['curl -u user:pass https://example.com', '-u user:pass'],
  ['curl -uuser:pass https://example.com', '-uuser:pass'],
  ['curl --user user:pass https://example.com', '--user user:pass'],
  ['curl --user=user:pass https://example.com', '--user=user:pass'],
  ["curl -u 'user:p a s s' https://example.com", "-u 'user:p a s s'"],
  ['curl --user "user:p a s s" https://example.com', '--user "user:p a s s"'],
  ['curl -t secret https://example.com', '-t secret'],
  ['curl -tsecret https://example.com', '-tsecret'],
  ['curl -sSu user:pass https://example.com', 'u user:pass'],
  ['curl -U proxy:pass -x http://proxy https://example.com', '-U proxy:pass'],
  ['curl --proxy-user proxy:pass https://example.com', '--proxy-user proxy:pass'],
  ['curl -s https://a.example.com && curl -u user:pass x', '-u user:pass'],
  ['curl -u \\\n  user:pass x', '-u \\\n  user:pass'],
  [JSON.stringify('curl -u user:pass x\nls'), '-u user:pass'],
  ['curl --oauth2-bearer hunter2 https://x', '--oauth2-bearer hunter2'],
  ['curl --oauth2-bearer=hunter2 https://x', '--oauth2-bearer=hunter2'],
  ['curl --pass hunter2 --key k.pem https://x', '--pass hunter2'],
  ['curl --pass "my phrase" https://x', '--pass "my phrase"'],
  ['curl --proxy-pass hunter2 https://x', '--proxy-pass hunter2'],
  ['curl "--pass" hunter2 https://x', '"--pass" hunter2'],
  ['curl --cookie sid=hunter2 https://x', '--cookie sid=hunter2'],
  ['curl --cookie=sid=hunter2 https://x', '--cookie=sid=hunter2'],
  ['curl -b "sid=hunter2" https://x', '-b "sid=hunter2"'],
  ['curl -b sid=hunter2 https://x', '-b sid=hunter2'],
  ['curl -bsid=hunter2 https://x', '-bsid=hunter2'],
  ['curl -sb sid=hunter2 https://x', 'b sid=hunter2'],
  // -b also takes a cookie file. Its name is redacted too, since telling the two apart needs
  // the file system.
  ['curl -b cookies.txt https://x', '-b cookies.txt'],
  ['curl --passive -u user:pass x', '-u user:pass'],
  ['curl --cookie-jar jar.txt -b sid=hunter2 x', '-b sid=hunter2'],
  ['curl --passive https://x'],
  ['curl --cookie-jar jar.txt https://x'],
  ['curl --cookie-jar=jar.txt https://x'],
  ['curl -c jar.txt https://x'],
  ['curl --key k.pem https://x'],
  ['curl --output -b.txt https://x'],
  ['curl -XPUT -d @body.json https://example.com'],
  ['curl -T upload.txt https://example.com'],
  ['curl --upload-file upload.txt https://example.com'],
  ['curl -o -t.txt https://example.com'],
  ['curl -s https://example.com\nsort -t , -k2 data.csv'],
  ['docker run -u 1000 node'],
  ['tmux attach -t main'],
  [JSON.stringify('cd /tmp\ncurl -u user:pass x'), '-u user:pass'],
  [JSON.stringify('set -e\n\tcurl -sSu me:hunter2 x'), 'u me:hunter2'],
  ['\x1b[32mcurl -u me:hunter2 x', '-u me:hunter2'],
  [JSON.stringify('cd /tmp\nmysql -phunter2'), '-phunter2'],
  [JSON.stringify('set -e\n\tmysql -phunter2 db'), '-phunter2'],
  ['\x1b[32mmysql -phunter2 db', '-phunter2'],
  ['libcurl -u user:pass x'],
  ['pymysql -psecret'],
  ['curl -"u" me:hunter2 x', 'u" me:hunter2'],
  ["curl -s'u' me:hunter2 x", "u' me:hunter2"],
  ['curl -o"" -t.txt https://example.com'],
  [JSON.stringify('\x1b[32mcurl -u me:hunter2 x'), '-u me:hunter2'],
  [JSON.stringify('\x1b[1mmysql -phunter2 db'), '-phunter2'],
  [JSON.stringify('\fcurl -u me:hunter2 x'), '-u me:hunter2'],
  [JSON.stringify('curl -"u" me:hunter2 x'), 'u\\" me:hunter2'],
  [JSON.stringify('curl -u"" me:hunter2 x'), '-u\\"\\" me:hunter2'],
  [
    'curl -H "Authorization: Basic YWxpY2U6czNjcmV0cHc=" https://api.example.com',
    'Authorization: Basic YWxpY2U6czNjcmV0cHc=',
  ],
  [
    "curl --header 'authorization: basic YWxpY2U6czNjcmV0cHc=' https://api.example.com",
    'authorization: basic YWxpY2U6czNjcmV0cHc=',
  ],
  [
    'curl -H"Authorization: Basic YWxpY2U6czNjcmV0cHc=" https://api.example.com',
    'Authorization: Basic YWxpY2U6czNjcmV0cHc=',
  ],
  ["curl -H'X-Api-Key: S3CRET9' https://api.example.com", 'X-Api-Key: S3CRET9'],
  [
    JSON.stringify('curl -H"Authorization: Basic YWxpY2U6czNjcmV0cHc=" https://x'),
    'Authorization: Basic YWxpY2U6czNjcmV0cHc=',
  ],
  [JSON.stringify('curl -H"X-Api-Key: S3CRET9" https://x'), 'X-Api-Key: S3CRET9'],
  ['curl -H"Proxy-Authorization: Basic YQ==" x', 'Proxy-Authorization: Basic YQ=='],
  ['curl --header="X-Api-Key: S3CRET9" x', 'X-Api-Key: S3CRET9'],
  ['curl -H X-Api-Key:S3CRET9 x', 'X-Api-Key:S3CRET9'],
  ['curl -HX-Api-Key:S3CRET9 x', 'X-Api-Key:S3CRET9'],
  ['curl -hapi-key:S3CRET9 x', 'api-key:S3CRET9'],
  ['curl -HAuthorization:Basic YQ== x', 'Authorization:Basic YQ=='],
  ['curl -HProxy-Authorization:Basic YQ== x', 'Proxy-Authorization:Basic YQ=='],
  ['curl -HX-Api-Key:"S3 CRET9" x', 'X-Api-Key:"S3 CRET9"'],
  [JSON.stringify('curl -HX-Api-Key:S3CRET9 x'), 'X-Api-Key:S3CRET9'],
  [JSON.stringify('curl -HAuthorization:Basic YQ== x'), 'Authorization:Basic YQ=='],
  [JSON.stringify('curl x \\\n-HX-Api-Key:S3CRET9'), 'X-Api-Key:S3CRET9'],
  ['curl --header=X-Api-Key:S3CRET9 x', 'X-Api-Key:S3CRET9'],
  ['curl --proxy-header=Proxy-Authorization:Basic YQ== x', 'Proxy-Authorization:Basic YQ=='],
  ['sort -h api-key.txt'],
  ['du -Hs /tmp'],
  ['grep -H pattern file'],
  ['ssh -Hostname x'],
  ['curl -Hfoo:bar x'],
  ['curl -H x'],
  ['curl -HX-Api-Keys:abc x'],
  ['curl -HAuthorization:Basically x'],
  [`${PROSE}curl -u 'me:S3 CRET9' x`, "-u 'me:S3 CRET9'"],
  [`${PROSE}curl --user 'me:S3 CRET9' x`, "--user 'me:S3 CRET9'"],
  [`${PROSE}curl -u 'me:S3\tCRET9' x`, "-u 'me:S3\tCRET9'"],
  [`${PROSE}curl -u '${'a'.repeat(4094)} b' x`, `-u '${'a'.repeat(4094)} b'`],
  [`${PROSE}curl -u '${'a'.repeat(4095)} b' x`],
  [`${PROSE}tool --password '${'a'.repeat(4097)}' x`, `--password '${'a'.repeat(4097)}'`],
  [`${PROSE}http x X-Api-Key:'S3 CRET9'`, 'S3 CRET9'],
  [`${PROSE}curl -H X-Api-Key:'S3 CRET9' x`, 'S3 CRET9'],
  ['echo "$(http x X-Api-Key:"S3 CRET9")"', 'S3 CRET9'],
  [`${PROSE}curl -H 'X-Api-Key: S3 CRET9' x`, 'X-Api-Key: S3 CRET9'],
  [`${PROSE}curl -sH 'X-Api-Key: S3 CRET9' x`, 'X-Api-Key: S3 CRET9'],
  [`${PROSE}curl -H\\\n  'X-Api-Key: S3 CRET9' x`, 'X-Api-Key: S3 CRET9'],
  [`${PROSE}tool --password 'S3 CRET9' x`, "--password 'S3 CRET9'"],
  [`${PROSE}API_KEY='S3 CRET9' x`, "API_KEY='S3 CRET9'"],
  [`${PROSE}http x 'X-Api-Key: S3 CRET9'`, ' S3 CRET9'],
  ['echo "$(curl -H "X-Api-Key: S3 CRET9" x)"', 'X-Api-Key: S3 CRET9'],
  ['echo "$(curl -sH "X-Api-Key: S3 CRET9" x)"', 'X-Api-Key: S3 CRET9'],
  ['echo "$(http x "X-Api-Key: S3 CRET9")"', ' S3 CRET9'],
  [JSON.stringify(`${PROSE}curl -u 'me:S3 CRET9' x`), "-u 'me:S3 CRET9'"],
  [JSON.stringify('echo "$(curl -H "X-Api-Key: S3 CRET9" x)"'), 'X-Api-Key: S3 CRET9'],
  [`${PROSE}curl -H 'X-Api-Key: a b'"S3 CRET9" x`, 'X-Api-Key: a b', '"S3 CRET9"'],
  [`${PROSE}curl -u 'me:a b'"S3 CRET9" x`, `-u 'me:a b'"S3 CRET9"`],
  [`curl -H 'X-Api-Key: a b'"S3 CRET9" x`, 'X-Api-Key: a b', '"S3 CRET9"'],
  [`curl -sH 'X-Api-Key: a b'"S3 CRET9" x`, 'X-Api-Key: a b', '"S3 CRET9"'],
  [`curl -H 'X-Api-Key: a b'S3'CRET 9' x`, 'X-Api-Key: a b', "S3'CRET 9'"],
  ['echo "$(curl -H "X-Api-Key: a b""S3 CRET9" x)"', 'X-Api-Key: a b', '"S3 CRET9"'],
  [`${PROSE}http x 'X-Api-Key: a b'"S3 CRET9"`, ' a b', '"S3 CRET9"'],
  [`http x 'X-Api-Key: a b'"S3 CRET9"`, ' a b', '"S3 CRET9"'],
  [`${PROSE}http x X-Api-Key:'a b'"S3 CRET9"`, 'a b', '"S3 CRET9"'],
  [`http x X-Api-Key:'a b'"S3 CRET9"`, 'a b', '"S3 CRET9"'],
  [
    JSON.stringify(`${PROSE}curl -H 'X-Api-Key: a b'"S3 CRET9" x`),
    'X-Api-Key: a b',
    '\\"S3 CRET9\\"',
  ],
  [JSON.stringify('curl -H "X-Api-Key: a b""S3 CRET9" x'), 'X-Api-Key: a b', '\\"S3 CRET9\\"'],
  [JSON.stringify(`http x 'X-Api-Key: a b'"S3 CRET9"`), ' a b', '\\"S3 CRET9\\"'],
  [JSON.stringify('http x "X-Api-Key: a b""S3 CRET9"'), ' a b', '\\"S3 CRET9\\"'],
  [JSON.stringify('http x X-Api-Key:"a b""S3 CRET9"'), 'a b', '\\"S3 CRET9\\"'],
  [`${PROSE}curl -H 'X-Api-Key: a b' "S3 CRET9" x`, 'X-Api-Key: a b'],
  ['echo "$(http x "X-Api-Key: a b"\\"S3 CRET9\\")"', ' a b', '\\"S3 CRET9\\"'],
  [`curl -H X-Api-Key:a'${'b'.repeat(4097)}' x`, 'X-Api-Key:a'],
  [`curl -H 'X-Api-Key: a b'"S3"Z9'Q7 8' x`, 'X-Api-Key: a b', `"S3"Z9'Q7 8'`],
  [`curl -H 'X-Api-Key: a b'\\"S3 x\\" y`, 'X-Api-Key: a b'],
  [`bash -c "curl -H 'X-Api-Key: a b'\\"S3\\\\x\\" y"`, 'X-Api-Key: a b'],
  [
    `bash -c "curl -H 'X-Api-Key: a b'\\"${'a'.repeat(4094)} b\\" x"`,
    'X-Api-Key: a b',
    `\\"${'a'.repeat(4094)} b\\"`,
  ],
  ["Don't run ls -u 'a b' x"],
  [`${PROSE}curl -A 'Mozilla 5' x`],
  ['echo "$(date -u "+%H %M")"'],
  ['echo "$(ls -u "a b" x)"'],
  ["curl x \\\n-u 'me:S3 CRET9' y", "-u 'me:S3 CRET9'"],
  ["curl --user\\\n  'me:S3 CRET9' x", "--user\\\n  'me:S3 CRET9'"],
  ['docker login -p\\\n  S3CRET9 r', '-p\\\n  S3CRET9'],
  ['redis-cli -a\\\n  S3CRET9 ping', '-a\\\n  S3CRET9'],
  ['sshpass -p\\\n  S3CRET9 ssh h', '-p\\\n  S3CRET9'],
  ['curl -sH\\\n  X-Api-Key:S3CRET9 x', 'X-Api-Key:S3CRET9'],
  ['curl -sH\\\nX-Api-Key:S3CRET9 x', 'X-Api-Key:S3CRET9'],
  [JSON.stringify('curl -sH\\\nX-Api-Key:S3CRET9 x'), 'X-Api-Key:S3CRET9'],
  ['curl -u\\\n\\\n  me:S3CRET9 x', '-u\\\n\\\n  me:S3CRET9'],
  ['curl x \\"y -u me:S3CRET9 \\\n z', '-u me:S3CRET9'],
  [JSON.stringify("curl -u\\\n  'me:S3 CRET9' x"), "-u\\\\\\n  'me:S3 CRET9'"],
  [JSON.stringify("curl x \\\n-u 'me:S3 CRET9' y"), "-u 'me:S3 CRET9'"],
  [JSON.stringify("curl --user\\\n  'me:S3 CRET9' x"), "--user\\\\\\n  'me:S3 CRET9'"],
  [JSON.stringify('docker login -p\\\n  S3CRET9 r'), '-p\\\\\\n  S3CRET9'],
  // Bash keeps \n in a double-quoted string, so it does not end the command there.
  ['bash -c "curl x \\n -u me:S3CRET9"', '-u me:S3CRET9'],
  ['curl -sSH X-Api-Key:S3CRET9 x', 'X-Api-Key:S3CRET9'],
  ['curl -sHX-Api-Key:S3CRET9 x', 'X-Api-Key:S3CRET9'],
  ['curl -sSH "X-Api-Key: S3CRET9" x', 'X-Api-Key: S3CRET9'],
  ["curl -sSH 'X-Api-Key: S3CRET9' x", 'X-Api-Key: S3CRET9'],
  ['curl -sH"X-Api-Key: S3CRET9" x', 'X-Api-Key: S3CRET9'],
  ['curl -sH X-Api-Key: S3CRET9 x', 'X-Api-Key: S3CRET9'],
  ['curl -sSH "Authorization: Basic YQ==" x', ' Basic YQ=='],
  ['curl -sH "Proxy-Authorization: Basic YQ==" x', ' Basic YQ=='],
  ['curl -u "Authorization: Basic YQ=="x"', '-u "Authorization: Basic YQ=="x"'],
  [JSON.stringify('curl -u x" TOKEN="N8 AM8"'), '-u x', 'TOKEN=\\"N8 AM8\\"'],
  ['curl -sHProxy-Authorization:Basic YQ== x', 'Proxy-Authorization:Basic YQ=='],
  ['curl -o out.txt -sSH X-Api-Key:S3CRET9 x', 'X-Api-Key:S3CRET9'],
  [JSON.stringify('curl -sSH X-Api-Key:S3CRET9 x'), 'X-Api-Key:S3CRET9'],
  [JSON.stringify('curl -sHX-Api-Key:S3CRET9 x'), 'X-Api-Key:S3CRET9'],
  [JSON.stringify('curl -sSH "X-Api-Key: S3CRET9" x'), 'X-Api-Key: S3CRET9'],
  [JSON.stringify('curl -sHProxy-Authorization:Basic YQ== x'), 'Proxy-Authorization:Basic YQ=='],
  ['grep -rH api-key file'],
  ['du -sH x'],
  ['ls -lH'],
  ['curl -sS x'],
  ['curl -sH foo:bar x'],
  ['curl -sHs X-Api-Key:S3CRET9 x'],
  ['curl -o -sH X-Api-Key:S3CRET9 x'],
  ['curl -sA X-Api-Key:S3CRET9 x'],
  ['curl --user-agent X-Api-Key:S3CRET9 x'],
  // Known over-redaction: no word boundary before the joined header name.
  ['grep -Hapi-key file', 'api-key file'],
  ['git log -Hauth-token x', 'auth-token x'],
  ['curl -H "Authorization : Basic YQ==" x', 'Authorization : Basic YQ=='],
  ['curl -H "Authorization: Basically x" x'],
  ['curl -H "Authorization: Basic" https://api.example.com'],
  ['curl -H "Authorization: Digest abc" https://api.example.com'],
  ['echo Authorization: Basic abc'],
  ['curl -H "Proxy-Authorization: Basic YQ==" x', 'Proxy-Authorization: Basic YQ=='],
  ["curl --proxy-header 'proxy-authorization: basic YQ==' x", 'proxy-authorization: basic YQ=='],
  ['curl --proxy-header "X-Api-Key: S3CRET9" x', 'X-Api-Key: S3CRET9'],
  ['curl -H Authorization:"Basic YQ==" x', 'Basic YQ=='],
  ['http x Authorization:"Basic YQ=="', 'Basic YQ=='],
  ["http x 'Proxy-Authorization: Basic YQ=='", ' Basic YQ=='],
  [JSON.stringify('http x Authorization:"Basic YQ=="'), 'Basic YQ=='],
  ['http x X-Api-Key:"S3 CRET9"', 'S3 CRET9'],
  ["http x 'X-Api-Key: S3 CRET9'", ' S3 CRET9'],
  [JSON.stringify("http x 'X-Api-Key: S3 CRET9'"), ' S3 CRET9'],
  [JSON.stringify('http x "X-Api-Key: S3 CRET9"'), ' S3 CRET9'],
  [`bash -c "http x 'X-Api-Key: S3 CRET9'"`, ' S3 CRET9'],
  ["http x $'X-Api-Key: S3 CRET9'", ' S3 CRET9'],
  [
    'curl --proxy-header "Proxy-Authorization: Bearer abcdefghijklmnopqrstuvwx" x',
    'Bearer abcdefghijklmnopqrstuvwx',
  ],
  ['echo X-Api-Key: abc'],
  ['echo Authorization:"Basically fine"'],
  ['http x X-Api-Key:S3CRET9'],
  ['npm run api-key:rotate'],
  [JSON.stringify('bash -c "curl -H \\"X-Api-Key: S3CRET9\\" x; rm -rf /tmp/x"')],
  ['git commit -m "api-key rotation"'],
  ['docker login -u me -p s3cretpw', '-p s3cretpw'],
  ['docker login -p s3cretpw -u me registry.example.com', '-p s3cretpw'],
  ['docker login -u me -p "my pass" registry', '-p "my pass"'],
  ['docker login -ps3cretpw', '-ps3cretpw'],
  [JSON.stringify('cd /tmp\ndocker login -p s3cretpw'), '-p s3cretpw'],
  ['docker login -u me --password-stdin'],
  ['docker login -p --username me registry.example.com'],
  ['docker ps -p 8080'],
  ['docker login -u me && docker run -p 8080:80 nginx'],
  ['sshpass -p hunter2 ssh -p 2222 host', '-p hunter2'],
  ['sshpass -phunter2 ssh host', '-phunter2'],
  ['sshpass -e -p hunter2 ssh host', '-p hunter2'],
  ["sshpass -p 'hun ter2' scp a host:/b", "-p 'hun ter2'"],
  ['sshpass -P prompt -p hunter2 ssh host', '-p hunter2'],
  ['sshpass -e ssh -p 2222 host'],
  ['sshpass -f pw.txt ssh -p 2222 host'],
  ['redis-cli -a s3cretpw ping', '-a s3cretpw'],
  ['redis-cli -h host -p 6380 -a s3cretpw ping', '-a s3cretpw'],
  ['redis-cli --pass s3cretpw ping', '--pass s3cretpw'],
  ['\x1b[32mredis-cli -a s3cretpw', '-a s3cretpw'],
  ['redis-cli -h host -p 6380 ping'],
  ['redis-cli ping; ls -a'],
  ['redis-cli ping | sort -a x'],
  ['redis-cli --pass'],
  ['redis-cli -a --version'],
  ['ls -a redis-cli'],
];

const cases = (rows: Row[]): [string, Row][] =>
  rows.map((row) => [JSON.stringify(row[0].length > 80 ? `${row[0].slice(0, 60)}…` : row[0]), row]);

describe('secret arguments', () => {
  it.each(cases([...KEEPS_COMMAND, ...REDACTS]))('redactSensitive() stores %s', (_title, row) => {
    expect(redactSensitive(row[0])).toBe(stored(row));
  });

  describe('processHook()', () => {
    const env = { ...process.env };
    let dir = '';

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'redaction-'));
      process.env.NEW_RELIC_AI_MCP_STORAGE_PATH = dir;
      process.env.NEW_RELIC_AI_MCP_BUFFER_PATH = join(dir, 'buffer.jsonl');
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
      process.env = { ...env };
    });

    function save(command: string): { toolInput: Record<string, unknown>; inputContent?: string } {
      const hook = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } };
      processHook(JSON.stringify({ ...hook, session_id: 'sess-1', cwd: '/projects/test' }));
      const lines = readFileSync(join(dir, 'buffer.jsonl'), 'utf8').trim().split('\n');
      return JSON.parse(lines[lines.length - 1]) as ReturnType<typeof save>;
    }

    const store = (command: string): Record<string, unknown> => save(command).toolInput;

    it.each(cases(KEEPS_COMMAND))('stores %s and keeps it destructive', (_title, row) => {
      const toolInput = store(row[0]);
      expect(toolInput.command).toBe(stored(row));
      expect(parseToolSpecificFields('Bash', toolInput, undefined).bashDestructive).toBe(true);
    });

    it.each(cases(REDACTS))('stores %s', (_title, row) => {
      expect(store(row[0]).command).toBe(stored(row));
    });

    it.each([
      ['cd /tmp\ncurl -u me:hunter2 x', '{"command":"cd /tmp\\ncurl [REDACTED] x"}'],
      ['cd /tmp\nmysql -phunter2', '{"command":"cd /tmp\\nmysql [REDACTED]"}'],
      ['cd /tmp\ndocker login -p hunter2', '{"command":"cd /tmp\\ndocker login [REDACTED]"}'],
      ['cd /tmp\nsshpass -p hunter2 ssh h', '{"command":"cd /tmp\\nsshpass [REDACTED] ssh h"}'],
      ['cd /tmp\nredis-cli -a hunter2 ping', '{"command":"cd /tmp\\nredis-cli [REDACTED] ping"}'],
      ['curl -H "Authorization: Basic YQ==" x', '{"command":"curl -H \\"[REDACTED]\\" x"}'],
      [
        'curl --proxy-header "Proxy-Authorization: Basic YQ==" x',
        '{"command":"curl --proxy-header \\"[REDACTED]\\" x"}',
      ],
      ['http x Authorization:"Basic YQ=="', '{"command":"http x Authorization:\\"[REDACTED]\\""}'],
      ['curl -HX-Api-Key:S3CRET9 x', '{"command":"curl -H[REDACTED] x"}'],
      ['curl -sSH X-Api-Key:S3CRET9 x', '{"command":"curl -sSH [REDACTED] x"}'],
    ])('records the content of %j with its password redacted', (command, content) => {
      process.env.NEW_RELIC_AI_MCP_RECORD_CONTENT = 'true';
      expect(save(command).inputContent).toBe(content);
    });

    it('numbers recorded keys that redact to the same text', () => {
      process.env.NEW_RELIC_AI_MCP_RECORD_CONTENT = 'true';
      const tool_input = { 'redis-cli -a one': 1, 'redis-cli -a two': 2 };
      const hook = { hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input };
      processHook(JSON.stringify({ ...hook, session_id: 'sess-1', cwd: '/projects/test' }));
      const event = JSON.parse(readFileSync(join(dir, 'buffer.jsonl'), 'utf8').trim()) as {
        inputContent: string;
      };
      expect(event.inputContent).toBe('{"redis-cli [REDACTED]":1,"redis-cli [REDACTED] (2)":2}');
    });

    const SPLIT = `echo ${'x'.repeat(1_048_554)} `;
    const WHOLE = `echo ${'x'.repeat(1_048_571)}`;

    it.each([
      ['redactSensitive()', (command: string) => redactSensitive(command)],
      ['processHook()', (command: string) => store(command).command],
    ])('%s drops only a word that the 1 MB cut splits', (_path, save) => {
      expect(save(`${SPLIT}ghp_${'B'.repeat(36)} tail`)).toBe(SPLIT);
      expect(save(`${WHOLE} rm -rf /tmp/x`)).toBe(WHOLE);
      expect(save('B'.repeat(1_048_577))).toBe('');
    });
  });
});

type Rand = () => number;

function parkMiller(seed: number): Rand {
  let state = seed;
  return () => (state = (state * 48271) % 2147483647) / 2147483647;
}

const pick = <T>(rand: Rand, items: readonly T[]): T =>
  items[Math.floor(rand() * items.length)] as T;

// Digits mark the secret: no prefix, flag, separator or `rm -rf /tmp/x` contains one.
const marker = (rand: Rand): string => String(Math.floor(rand() * 99_999));

function fill(rand: Rand, extras: readonly string[]): string {
  let out = marker(rand);
  for (let n = Math.floor(rand() * 4); n > 0; n--) out += pick(rand, extras) + marker(rand);
  return out;
}

const BARE_ESCAPES = ['\\ ', '\\;', '\\|', '\\&', '\\(', '\\)', '\\<', '\\>', '\\`', '\\"', "\\'"];
const IN_DOUBLE = [' ', '\t', ';', '|', '&&', '(', ')', '<', '>', "'", '\\"', '\\\\', '\n', '\\\n'];
const IN_SINGLE = [' ', '\t', ';', '|', '&&', '(', ')', '"', '\\', '\n'];
const IN_ANSI = [' ', ';', '|', "\\'", '\\\\', '"'];

const PARTS: readonly ((rand: Rand) => string)[] = [
  (rand) => fill(rand, [...BARE_ESCAPES, '', '\\\\', '$']),
  (rand) => `"${fill(rand, IN_DOUBLE)}"`,
  (rand) => `'${fill(rand, IN_SINGLE)}'`,
  (rand) => `$'${fill(rand, IN_ANSI)}'`,
];

function shellWord(rand: Rand): string {
  let word = pick(rand, PARTS)(rand);
  for (let n = Math.floor(rand() * 3); n > 0; n--) {
    word += (rand() < 0.2 ? '\\\n' : '') + pick(rand, PARTS)(rand);
  }
  return word;
}

const FLAGS = [
  'curl --token |npm run deploy -- --password |deploy --api-key |deploy --client-secret ',
  '|deploy --db-password |tool --a-b-c-d-token |keytool -password |curl --token=|tool --api_key=',
  '|deploy --client-secret=|env API_KEY=|export TOKEN=|mysql -u root -p|curl -u |curl -t ',
  '|docker login -p |sshpass -p |redis-cli -a ',
]
  .join('')
  .split('|');
const SEPARATORS = [';', '|', '&&', ')', '\n'];

function command(rand: Rand): string {
  const flag = pick(rand, FLAGS);
  const separator = pick(rand, SEPARATORS);
  const space = (): string => (rand() < 0.5 ? ' ' : '');
  const open = separator === ')' ? '(' : '';
  return `${open}${flag}${shellWord(rand)}${space()}${separator}${space()}rm -rf /tmp/x`;
}

describe('secret argument redaction over random shell words', () => {
  const SEED = 1164;
  const CASES = 2000;

  it.each([
    ['redactSensitive()', redactSensitive],
    ["the collector's redact()", redact],
  ])(
    '%s hides every secret character and keeps the rm after it classifiable',
    (_path, redactor) => {
      const rand = parkMiller(SEED);
      const failures: { command: string; stored: string }[] = [];
      for (let n = 0; n < CASES; n++) {
        const input = command(rand);
        const stored = redactor(input);
        if (/\d/.test(stored) || !classifyBash(stored).isDestructive) {
          failures.push({ command: input, stored });
        }
      }
      expect(failures).toEqual([]);
    },
  );
});

// The reviewer's shapes. The secret is the digits in each Q…Z, after a flag, a mysql -p, a header
// or NAME=, in an optional wrapper, after a prefix that may leave a quote open.
const SECRETS = [
  'm',
  '"m"',
  "'m'",
  '"m m"',
  "'m m'",
  'm\\ m',
  '"m\\"m"',
  "$'m\\'m'",
  'm"m"',
  '\\\nm',
  '\\\r\nm',
  '"m \\\n m"',
  "'m\nm'",
  '"m\nm"',
  `'m'"m"`,
  '"m\\\\m"',
  "$'m\\nm'",
  '-H "X-Api-Key: m"',
  '-H "X-Api-Key: m m"',
  "-H 'X-Auth-Token: m m'",
  '--proxy-header "Proxy-Authorization: Basic m m"',
  'Authorization:"Basic m m"',
  "'Proxy-Authorization: Basic m'",
  "'X-Api-Key: m m'",
];
const ARGUMENTS = [
  'curl --token ',
  'tool --api-key=',
  'mysql -u root -p',
  'curl ',
  'env API_KEY=',
  'TOKEN=',
  'TOKEN=\n',
  'TOKEN:\r\n',
  '  TOKEN =\r\n  ',
  'PASSWORD\n= ',
  'deploy --client-secret=',
  'psql --db-password ',
  'curl -sSu ',
  'curl --user=',
];
const PREFIXES = [
  '',
  "# Don't paste this key\n",
  "Bob's box: ",
  "echo o'clock && ",
  'ls\r\n',
  "cat <<'EOF' > n.txt\nDon't copy\nEOF\n",
  'echo "it\'s fine" && ',
  'npm run x \\\n  ',
];
const ENDS = [';', ' ; ', '|', ' && ', '&&', '\n', '\r\n', ' ', ' & '];

function reviewerCommand(rand: Rand): string {
  const secret = pick(rand, SECRETS).replace(/m/g, () => `Q${marker(rand)}Z`);
  const body = `${pick(rand, ARGUMENTS)}${secret} x`;
  const json = `bash -c \\"${JSON.stringify(body).slice(1, -1)}\\"`;
  const wrapped = pick(rand, [body, body, `echo $(${body})`, `bash -c "${body}"`, json]);
  return `${pick(rand, PREFIXES)}${wrapped}${pick(rand, ENDS)}rm -rf /tmp/x`;
}

describe('secret argument redaction against the earlier NAME=\\S+ rule', () => {
  const EARLIER = [
    /(?<![a-zA-Z])(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSPHRASE|PRIVATE_KEY)(?![a-zA-Z])[\s]*[=:]\s*\S+/gi,
    ...REDACTION_PATTERNS,
  ];
  const digits = (text: string): number => text.replace(/\D/g, '').length;

  it.each([
    ['redactSensitive()', redactSensitive],
    ["the collector's redact()", redact],
  ])('%s never stores a secret digit more than the earlier rules did', (_path, redactor) => {
    const rand = parkMiller(7166);
    const worse: { command: string; stored: string; earlier: string }[] = [];
    for (let n = 0; n < 4000; n++) {
      const input = n % 2 === 0 ? reviewerCommand(rand) : command(rand);
      const [stored, earlier] = [redactor(input), redactSensitive(input, EARLIER)];
      if (digits(stored) > digits(earlier)) worse.push({ command: input, stored, earlier });
    }
    expect(worse).toEqual([]);
  });
});
