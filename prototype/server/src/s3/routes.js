// The storage endpoint. Conceptually a separate service — it authenticates ONLY by
// presigned signature, never by JWT, exactly as Amazon S3 does. The browser talks here
// directly for every byte; the API never proxies content.
import express from 'express';
import * as s3 from './localS3.js';
import { verifySignature } from './presign.js';

export const s3Router = express.Router();

// `type: () => true` rather than '*/*': a Blob slice is sent with no Content-Type at all,
// and a matcher keyed on the header would skip those requests and leave the body unparsed.
s3Router.use(express.raw({ type: () => true, limit: '512mb' }));

function deny(res, reason) {
  return res.status(403).type('application/xml').send(`<Error><Code>${reason}</Code></Error>`);
}

// PUT — an upload part, or a whole small object.
s3Router.put('/:bucket/*', (req, res) => {
  const bucket = req.params.bucket;
  const key = decodeURIComponent(req.params[0]);
  const check = verifySignature(req, bucket, key);
  if (!check.ok) return deny(res, check.reason);

  if (!Buffer.isBuffer(req.body)) {
    return res.status(400).type('application/xml').send('<Error><Code>MalformedRequest</Code></Error>');
  }

  try {
    if (req.query.uploadId) {
      const part = s3.uploadPart({
        uploadId: String(req.query.uploadId),
        partNumber: Number(req.query.partNumber),
        body: req.body,
      });
      res.set('ETag', part.etag);
      res.set('Access-Control-Expose-Headers', 'ETag');
      return res.status(200).end();
    }
    const meta = s3.putObject({ bucket, key, body: req.body, contentType: req.get('content-type') });
    res.set('ETag', meta.etag);
    res.set('Access-Control-Expose-Headers', 'ETag');
    return res.status(200).end();
  } catch (err) {
    return res.status(err.status || 500).type('application/xml').send(`<Error><Code>${err.code}</Code></Error>`);
  }
});

// GET / HEAD — presigned retrieval, with Range support so <video> and <audio> can seek (§10.3).
function serve(req, res, headOnly) {
  const bucket = req.params.bucket;
  const key = decodeURIComponent(req.params[0]);
  const check = verifySignature(req, bucket, key);
  if (!check.ok) return deny(res, check.reason);

  try {
    s3.settleRestore({ bucket, key });
    const disposition = req.query['response-content-disposition'];
    if (headOnly) {
      const meta = s3.headObject({ bucket, key });
      res.set({ 'Content-Length': String(meta.size), 'Content-Type': meta.contentType, ETag: meta.etag });
      return res.status(200).end();
    }
    const range = req.get('range');
    const out = s3.getObject({ bucket, key, range });
    res.set({
      'Content-Type': out.meta.contentType,
      ETag: out.meta.etag,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=300',
    });
    if (disposition) res.set('Content-Disposition', String(disposition));
    if (out.partial) {
      res.set('Content-Range', `bytes ${out.start}-${out.end}/${out.total}`);
      return res.status(206).send(out.body);
    }
    return res.status(200).send(out.body);
  } catch (err) {
    return res.status(err.status || 500).type('application/xml').send(`<Error><Code>${err.code}</Code></Error>`);
  }
}

s3Router.get('/:bucket/*', (req, res) => serve(req, res, false));
s3Router.head('/:bucket/*', (req, res) => serve(req, res, true));
