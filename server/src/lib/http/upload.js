import { HttpError } from './http-error.js';

export async function readRequestBuffer(req, limit) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    throw new HttpError(413, 'upload_too_large', 'The uploaded file exceeds the size limit');
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.byteLength;
    if (total > limit) {
      throw new HttpError(413, 'upload_too_large', 'The uploaded file exceeds the size limit');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

export function requestMediaType(req) {
  const value = String(req.headers['content-type'] || '');
  return value.split(';')[0].trim().toLowerCase();
}

export async function readMultipart(req, limit) {
  const buffer = await readRequestBuffer(req, limit);
  let form;
  try {
    const request = new Request('http://localhost/upload', {
      method: 'POST',
      headers: { 'content-type': req.headers['content-type'] },
      body: buffer,
    });
    form = await request.formData();
  } catch {
    throw new HttpError(400, 'invalid_request', 'The multipart upload is invalid');
  }

  const file = form.get('file');
  if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') {
    throw new HttpError(400, 'invalid_request', 'A file field is required');
  }

  const fields = {};
  for (const name of ['name', 'version', 'author_name', 'author_email']) {
    const value = form.get(name);
    if (typeof value === 'string') fields[name] = value;
  }

  return {
    fields,
    file: {
      buffer: Buffer.from(await file.arrayBuffer()),
      filename: typeof file.name === 'string' && file.name ? file.name : null,
      type: file.type || null,
    },
  };
}
