export async function verify(_plain: string, _hash: string): Promise<boolean> {
  throw new Error('Not implemented: hash.verify');
}

export async function hash(_plain: string): Promise<string> {
  throw new Error('Not implemented: hash.hash');
}