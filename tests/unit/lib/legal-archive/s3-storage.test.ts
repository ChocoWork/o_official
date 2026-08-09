jest.mock('@aws-sdk/client-s3', () => {
  class Command { constructor(public input: unknown) {} }
  return {
    S3Client: class {},
    PutObjectCommand: class PutObjectCommand extends Command {},
    HeadObjectCommand: class HeadObjectCommand extends Command {},
    GetObjectCommand: class GetObjectCommand extends Command {},
    CopyObjectCommand: class CopyObjectCommand extends Command {},
    DeleteObjectCommand: class DeleteObjectCommand extends Command {},
    ListObjectsV2Command: class ListObjectsV2Command extends Command {},
  };
});
import { S3ArchiveStorage } from '@/lib/legal-archive/s3-storage';

it('uses S3 object commands for private archive operations', async () => {
  const send = jest.fn(async (command) => {
    if (command.constructor.name === 'GetObjectCommand') {
      return { Body: { transformToByteArray: async () => new Uint8Array([1]) } };
    }
    return {};
  });
  const storage = new S3ArchiveStorage({ send } as never, 'private-bucket');
  await storage.putTemporary('_staging/run/orders.csv', new Uint8Array([1]), 'text/csv');
  await storage.exists('final/orders.csv');
  await storage.read('_staging/run/orders.csv');
  await storage.promote('_staging/run/orders.csv', 'final/orders.csv', false);
  const commands = send.mock.calls.map(([command]) => command.constructor.name);
  expect(commands).toEqual(expect.arrayContaining([
    'PutObjectCommand', 'HeadObjectCommand', 'GetObjectCommand', 'CopyObjectCommand',
  ]));
});
