import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { open, lstat, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { inflateRawSync } from "node:zlib";
import type { ToolRegistry } from "./registry.js";
import type { ToolContext } from "./contracts.js";
import type { WorkspaceFiles } from "./files.js";

const DocumentTypeSchema = z.enum(["txt", "md", "html", "csv", "json", "docx", "xlsx", "pdf"]);
const DocumentStatusSchema = z.enum(["indexed", "needs_helper", "failed"]);

export interface DocumentMetadata {
  id: string;
  owner: string;
  name: string;
  filePath: string | null;
  fileType: string;
  fileSize: number;
  status: string;
  createdAt: string;
}

interface Chunk {
  id: string;
  documentId: string;
  index: number;
  text: string;
  charCount: number;
}

interface SearchResult {
  source: string;
  page: string | null;
  text: string;
  score: number;
}

const CHUNK_SIZE = 3000; // Roughly 800 tokens
const CHUNK_OVERLAP = 400; // 100 token overlap
const MAX_SEARCH_RESULTS = 10;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

class ZipReader {
  private data: Buffer;
  constructor(buffer: Buffer) {
    this.data = buffer;
  }

  private findCentralDirOffset(): number {
    const sig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
    let pos = this.data.length - 22;
    while (pos >= 0) {
      if (this.data.subarray(pos, pos + 4).equals(sig)) {
        return this.data.readUInt32LE(pos + 16);
      }
      pos--;
    }
    throw new Error("Invalid ZIP file");
  }

  extractFile(path: string): Buffer | null {
    try {
      const centralDirOffset = this.findCentralDirOffset();
      let pos = centralDirOffset;

      while (pos < this.data.length) {
        const sig = this.data.readUInt32LE(pos);
        if (sig !== 0x02014b50) break; // End of central directory

        const nameLen = this.data.readUInt16LE(pos + 28);
        const extraLen = this.data.readUInt16LE(pos + 30);
        const commentLen = this.data.readUInt16LE(pos + 32);
        const fileName = this.data.toString("utf8", pos + 46, pos + 46 + nameLen);

        if (fileName === path) {
          const localHeaderOffset = this.data.readUInt32LE(pos + 42);
          const localSig = this.data.readUInt32LE(localHeaderOffset);
          if (localSig !== 0x04034b50) throw new Error("Invalid local header");

          const localNameLen = this.data.readUInt16LE(localHeaderOffset + 26);
          const localExtraLen = this.data.readUInt16LE(localHeaderOffset + 28);
          const compressedSize = this.data.readUInt32LE(localHeaderOffset + 18);
          const uncompressedSize = this.data.readUInt32LE(localHeaderOffset + 22);
          const compressionMethod = this.data.readUInt16LE(localHeaderOffset + 8);

          const dataOffset = localHeaderOffset + 30 + localNameLen + localExtraLen;
          const compressed = this.data.subarray(dataOffset, dataOffset + compressedSize);

          if (compressionMethod === 0) {
            return compressed;
          } else if (compressionMethod === 8) {
            return inflateRawSync(compressed);
          }
        }

        pos += 46 + nameLen + extraLen + commentLen;
      }
    } catch {
      return null;
    }
    return null;
  }
}

export class DocumentLibrary {
  constructor(
    private db: DatabaseSync,
  ) {
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents(
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        name TEXT NOT NULL,
        file_path TEXT,
        file_type TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'indexed',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS document_chunks(
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id),
        owner TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        chunk_text TEXT NOT NULL,
        char_count INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_document_chunks_doc ON document_chunks(document_id);
      CREATE INDEX IF NOT EXISTS idx_document_chunks_owner ON document_chunks(owner);
    `);
  }

  async addDocument(
    owner: string,
    name: string,
    content: string,
    fileType: string,
    filePath?: string,
  ): Promise<string> {
    const id = `doc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const now = new Date().toISOString();
    const fileSize = Buffer.byteLength(content);

    this.db.prepare(`
      INSERT INTO documents(id, owner, name, file_path, file_type, file_size, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'indexed', ?, ?)
    `).run(id, owner, name, filePath || null, fileType, fileSize, now, now);

    // Chunk the content
    const chunks = this.chunkText(content);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const chunkId = `chunk_${id}_${i}`;
      this.db.prepare(`
        INSERT INTO document_chunks(id, document_id, owner, chunk_index, chunk_text, char_count, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(chunkId, id, owner, i, chunk, chunk.length, now);
    }

    return id;
  }

  private chunkText(text: string): string[] {
    if (text.length <= CHUNK_SIZE) {
      return [text.trim()];
    }

    const chunks: string[] = [];
    let pos = 0;

    while (pos < text.length) {
      const chunkEnd = Math.min(pos + CHUNK_SIZE, text.length);
      const chunk = text.slice(pos, chunkEnd).trim();

      if (chunk.length > 0) {
        chunks.push(chunk);
      }

      // Move to next position with overlap
      const nextPos = pos + CHUNK_SIZE - CHUNK_OVERLAP;

      // Stop if we've reached the end
      if (chunkEnd >= text.length) {
        break;
      }

      pos = nextPos;
    }

    return chunks.length > 0 ? chunks : [text.trim()];
  }

  async extractText(buffer: Buffer, fileType: string): Promise<string> {
    switch (fileType) {
      case "txt":
      case "md":
        return buffer.toString("utf8");
      case "html":
        return this.stripHtmlTags(buffer.toString("utf8"));
      case "csv":
      case "json":
        return buffer.toString("utf8");
      case "docx":
        return this.extractDocxText(buffer);
      case "xlsx":
        return this.extractXlsxText(buffer);
      case "pdf":
        return ""; // Unsupported without dependency
      default:
        throw new Error(`Unsupported file type: ${fileType}`);
    }
  }

  private stripHtmlTags(html: string): string {
    return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  }

  private extractDocxText(buffer: Buffer): string {
    const zip = new ZipReader(buffer);
    const docXml = zip.extractFile("word/document.xml");
    if (!docXml) return "";

    const text = docXml.toString("utf8");
    return text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  }

  private extractXlsxText(buffer: Buffer): string {
    const zip = new ZipReader(buffer);
    const sharedStrings = zip.extractFile("xl/sharedStrings.xml");
    const sheet1 = zip.extractFile("xl/worksheets/sheet1.xml");

    if (!sharedStrings || !sheet1) return "";

    const strings = this.parseSharedStrings(sharedStrings.toString("utf8"));
    const rows = this.parseSheet(sheet1.toString("utf8"), strings);
    return rows.join("\t");
  }

  private parseSharedStrings(xml: string): string[] {
    const strings: string[] = [];
    const matches = xml.matchAll(/<si>.*?<t>(.*?)<\/t>.*?<\/si>/gs);
    for (const match of matches) {
      strings.push(match[1] || "");
    }
    return strings;
  }

  private parseSheet(xml: string, strings: string[]): string[] {
    const rows: string[] = [];
    const cellMatches = xml.matchAll(/<c[^>]*><v>(\d+)<\/v><\/c>/g);
    for (const match of cellMatches) {
      const idx = parseInt(match[1] || "0", 10);
      if (idx < strings.length) {
        rows.push(strings[idx]!);
      }
    }
    return rows;
  }

  async search(
    owner: string,
    query: string,
    limit = 3,
  ): Promise<SearchResult[]> {
    const words = query.match(/[\p{L}\p{N}]+/gu) ?? [];
    if (!words.length) return [];

    // Use LIKE search, matching all words
    const likeConditions = words.map(() => "dc.chunk_text LIKE ?").join(" AND ");
    const rows = this.db.prepare(`
      SELECT DISTINCT
        dc.id,
        dc.chunk_text,
        d.name
      FROM document_chunks dc
      JOIN documents d ON d.id = dc.document_id
      WHERE dc.owner = ? AND ${likeConditions}
      LIMIT ?
    `).all(owner, ...words.map((w) => `%${w}%`), limit) as unknown[];

    return (rows as Array<{ chunk_text: string; name: string }>).map((row) => ({
      source: String(row.name),
      page: null,
      text: String(row.chunk_text).slice(0, 300),
      score: 0,
    }));
  }

  list(owner: string): DocumentMetadata[] {
    const rows = this.db.prepare(`
      SELECT id, owner, name, file_path, file_type, file_size, status, created_at, updated_at
      FROM documents WHERE owner = ?
      ORDER BY created_at DESC
    `).all(owner);

    return rows.map((row) => ({
      id: String(row.id),
      owner: String(row.owner),
      name: String(row.name),
      filePath: row.file_path ? String(row.file_path) : null,
      fileType: String(row.file_type),
      fileSize: Number(row.file_size),
      status: String(row.status),
      createdAt: String(row.created_at),
    }));
  }

  async remove(owner: string, id: string): Promise<void> {
    const doc = this.db.prepare("SELECT owner FROM documents WHERE id = ?").get(id);
    if (!doc || String(doc.owner) !== owner) throw new Error("Document not found");

    this.db.prepare("DELETE FROM document_chunks WHERE document_id = ?").run(id);
    this.db.prepare("DELETE FROM documents WHERE id = ?").run(id);
  }
}

export function registerDocuments(
  registry: ToolRegistry,
  library: DocumentLibrary,
  files: WorkspaceFiles,
): void {
  registry.register({
    name: "documents.search",
    description:
      "Search indexed documents by keyword. Returns top 3 chunks with source names and passages.",
    permission: "documents.read",
    parameters: z.object({ query: z.string().min(1).max(200) }).strict(),
    execute: async ({ query }, context) => ({
      results: await library.search(context.owner, query, 3),
    }),
  });

  registry.register({
    name: "documents.list",
    description: "List all indexed documents and their status.",
    permission: "documents.read",
    parameters: z.object({}).strict(),
    execute: async (_args, context) => ({
      documents: library.list(context.owner),
    }),
  });

  registry.register({
    name: "documents.add",
    description:
      "Add a file or folder from the workspace, or paste text/URL content. Supported: .txt, .md, .html, .csv, .json, .docx, .xlsx. PDF needs external conversion.",
    permission: "documents.write",
    parameters: z
      .object({
        name: z.string().min(1).max(200),
        content: z.string().optional(),
        filePath: z.string().optional(),
      })
      .strict(),
    execute: async ({ name, content, filePath }, context) => {
      let text = content;
      let fileType = "txt";

      if (filePath) {
        const target = await files.checked(filePath);
        const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const stat = await handle.stat();
          if (stat.size > 10 * 1024 * 1024) throw new Error("File exceeds 10 MiB");
          const buffer = Buffer.alloc(stat.size);
          await handle.read(buffer, 0, stat.size, 0);

          // Detect file type
          if (filePath.endsWith(".docx") || filePath.endsWith(".docm")) {
            fileType = "docx";
          } else if (filePath.endsWith(".xlsx") || filePath.endsWith(".xlsm")) {
            fileType = "xlsx";
          } else if (filePath.endsWith(".pdf")) {
            return {
              id: `doc_${Date.now()}`,
              status: "needs_helper",
              message: "PDF documents need external conversion",
            };
          } else if (filePath.endsWith(".html") || filePath.endsWith(".htm")) {
            fileType = "html";
          } else if (filePath.endsWith(".md")) {
            fileType = "md";
          } else if (filePath.endsWith(".csv")) {
            fileType = "csv";
          } else if (filePath.endsWith(".json")) {
            fileType = "json";
          }

          text = await library.extractText(buffer, fileType);
        } finally {
          await handle.close();
        }
      }

      if (!text) throw new Error("No content to index");
      const id = await library.addDocument(context.owner, name, text, fileType, filePath);
      return { id, status: "indexed", chunks: Math.ceil(text.length / CHUNK_SIZE) };
    },
  });

  registry.register({
    name: "documents.remove",
    description: "Remove a document and its chunks from the library.",
    permission: "documents.write",
    parameters: z.object({ id: z.string().min(1).max(100) }).strict(),
    execute: async ({ id }, context) => {
      await library.remove(context.owner, id);
      return { removed: id };
    },
  });
}
