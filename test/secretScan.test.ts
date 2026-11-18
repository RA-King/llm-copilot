import { describeSecret, maskSecret, scanDiff, scanLine, scanText } from '../src/secretScan';

// Built from parts so the file itself does not trip a secret scanner.
const AWS = 'AKIA' + 'IOSFODNN7EXAMPLQ';
const GITHUB = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
const STRIPE = 'sk_live_' + '4eC39HqLyjWDarjtT1zdp7dc';

describe('scanLine', () => {
  it('recognises provider key formats', () => {
    expect(scanLine(`const key = "${AWS}";`).map(f => f.kind)).toEqual(['AWS access key']);
    expect(scanLine(`token: ${GITHUB}`).map(f => f.kind)).toEqual(['GitHub token']);
    expect(scanLine(`stripe.key = '${STRIPE}'`).map(f => f.kind)).toEqual(['Stripe secret key']);
    expect(scanLine('-----BEGIN OPENSSH PRIVATE KEY-----').map(f => f.kind)).toEqual(['private key']);
  });

  it('finds a password assigned in code or held in a connection string', () => {
    expect(scanLine('db_password = "Tr0ub4dor&3x"').map(f => f.kind)).toEqual(['hard-coded password']);
    expect(scanLine('url = postgres://app:s3cr3tpw@db.internal:5432/app').map(f => f.kind))
      .toEqual(['password in a connection string']);
  });

  it('leaves placeholders and lookups alone', () => {
    expect(scanLine('password = "changeme123"')).toEqual([]);
    expect(scanLine('api_key = "<your-api-key>"')).toEqual([]);
    expect(scanLine('secret: "${SECRET_FROM_ENV}"')).toEqual([]);
    expect(scanLine('password = process.env.DB_PASSWORD')).toEqual([]);
    expect(scanLine('const sky = "AKIA is a prefix"')).toEqual([]);
  });

  it('never shows the whole secret', () => {
    const [hit] = scanLine(`k = "${GITHUB}"`);
    expect(hit.preview).not.toContain(GITHUB.slice(4, 30));
    expect(hit.preview.startsWith('ghp_')).toBe(true);
    expect(maskSecret('short')).toBe('*****');
  });
});

describe('scanText', () => {
  it('numbers lines from where the text starts', () => {
    expect(scanText(`a\nb = "${AWS}"\r\nc`, 40)).toEqual([expect.objectContaining({ line: 41, kind: 'AWS access key' })]);
  });
});

describe('scanDiff', () => {
  const diff = [
    'diff --git a/src/config.ts b/src/config.ts',
    '--- a/src/config.ts',
    '+++ b/src/config.ts',
    '@@ -10,3 +10,4 @@ export const config = {',
    '   region: "eu-west-1",',
    `-  key: "${AWS}",`,
    '+  key: process.env.AWS_KEY,',
    `+  token: "${GITHUB}",`,
    '   retries: 3,',
    'diff --git a/.env.example b/.env.example',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/.env.example',
    '@@ -0,0 +1 @@',
    '+password = "changeme123"',
  ].join('\n');

  it('reports only what the change adds, at its line in the new file', () => {
    const found = scanDiff(diff);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ file: 'src/config.ts', line: 12, kind: 'GitHub token' });
    expect(describeSecret(found[0])).toMatch(/^Possible GitHub token in plain text \(ghp_\*+R8\)\./);
  });
});
