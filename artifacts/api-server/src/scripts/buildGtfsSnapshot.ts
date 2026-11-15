import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { serialize } from "node:v8";
import path from "node:path";
import { getArtespGtfsFeed } from "../lib/artespGtfsSource";

const outputPath = path.resolve(
  process.cwd(),
  "artifacts/api-server/dist/artesp-gtfs-index.json.gz",
);
const temporaryPath = `${outputPath}.tmp`;

async function main(): Promise<void> {
  const startedAt = Date.now();
  const feed = await getArtespGtfsFeed();
  const compressed = gzipSync(serialize(feed), { level: 6 });
  await mkdir(path.dirname(outputPath), { recursive: true });
  await rm(temporaryPath, { force: true });
  await writeFile(temporaryPath, compressed);
  await rename(temporaryPath, outputPath);
  console.info(
    JSON.stringify({
      event: "artesp_gtfs_snapshot_built",
      version: feed.source.version,
      compressedBytes: compressed.byteLength,
      durationMs: Date.now() - startedAt,
    }),
  );
}

main().catch((error: unknown) => {
  console.error("Falha ao gerar o índice GTFS pré-processado.", error);
  process.exitCode = 1;
});
