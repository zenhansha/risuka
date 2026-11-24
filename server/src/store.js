// A tiny JSON file store. A few users never need a database server.
// Writes go to a temp file and are renamed into place, so a crash never leaves half a file.
import fs from 'node:fs/promises';
import path from 'node:path';

export class Store {
  constructor(dir) {
    this.file = path.join(dir, 'applications.json');
    this.dir = dir;
    this.data = { applications: [] };
    this.queue = Promise.resolve();
  }

  async load() {
    await fs.mkdir(this.dir, { recursive: true });
    try {
      this.data = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (!Array.isArray(this.data.applications)) this.data.applications = [];
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      await this.save();
    }
    return this;
  }

  save() {
    // Serialize writes so two requests never interleave.
    this.queue = this.queue.then(async () => {
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(this.data, null, 2));
      await fs.rename(tmp, this.file);
    });
    return this.queue;
  }

  get(appId) {
    return this.data.applications.find((a) => a.appId === appId) ?? null;
  }

  findById(id) {
    return this.data.applications.find((a) => a.id === id) ?? null;
  }

  countPending() {
    return this.data.applications.filter((a) => a.status === 'pending').length;
  }

  async add(record) {
    this.data.applications.push(record);
    await this.save();
    return record;
  }

  async update(appId, patch) {
    const rec = this.get(appId);
    if (!rec) return null;
    Object.assign(rec, patch);
    await this.save();
    return rec;
  }
}
