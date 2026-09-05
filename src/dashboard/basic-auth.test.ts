import { checkBasicAuthToken } from './basic-auth.js';

describe('checkBasicAuthToken', () => {
  it('accepts the correct token as the Basic Auth password, ignoring username', () => {
    const header = `Basic ${Buffer.from('anyuser:secret-token').toString('base64')}`;
    expect(checkBasicAuthToken(header, 'secret-token')).toBe(true);
  });

  it('rejects a wrong password', () => {
    const header = `Basic ${Buffer.from('anyuser:wrong-token').toString('base64')}`;
    expect(checkBasicAuthToken(header, 'secret-token')).toBe(false);
  });

  it('rejects a missing Authorization header', () => {
    expect(checkBasicAuthToken(undefined, 'secret-token')).toBe(false);
  });

  it('rejects a non-Basic scheme', () => {
    const header = `Bearer secret-token`;
    expect(checkBasicAuthToken(header, 'secret-token')).toBe(false);
  });

  it('rejects malformed base64 without throwing', () => {
    expect(checkBasicAuthToken('Basic not-valid-base64!!!', 'secret-token')).toBe(false);
  });

  it('rejects a credential with no colon separator', () => {
    const header = `Basic ${Buffer.from('secret-token').toString('base64')}`;
    expect(checkBasicAuthToken(header, 'secret-token')).toBe(false);
  });
});
