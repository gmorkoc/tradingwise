// Stub for datauri/parser — not needed for browser GET requests
export default class DataURI {
  content = '';
  mimetype = '';
  base64 = '';
  constructor() {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  encode(_path: string, _cb: (...args: any[]) => void) {}
  encodeSync(_path: string) { return this; }
}
