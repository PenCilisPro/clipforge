import fs from "node:fs/promises";

const envText = await fs.readFile(".env.local", "utf8");
const m = envText.match(/^GOOGLE_CREDENTIALS_JSON=(.+)$/m);
if (!m) { console.error("GOOGLE_CREDENTIALS_JSON not found"); process.exit(1); }
const creds = JSON.parse(m[1]);
console.log("Using SA:", creds.client_email, "project:", creds.project_id);

const { Storage } = await import("@google-cloud/storage");
const storage = new Storage({ credentials: creds });
const bucket = storage.bucket("clipforge-media-storage");

const [exists] = await bucket.exists();
console.log("bucket exists:", exists);
if (!exists) process.exit(1);

const path = `probe/${Date.now()}-access-test.txt`;
await bucket.file(path).save("clipforge access probe " + new Date().toISOString());
console.log("upload OK:", `gs://clipforge-media-storage/${path}`);

const [meta] = await bucket.file(path).getMetadata();
console.log("read metadata OK, size:", meta.size);

await bucket.file(path).delete();
console.log("delete OK — full objectAdmin-level access confirmed");
