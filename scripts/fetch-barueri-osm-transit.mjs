import { mkdir, writeFile } from "node:fs/promises";

const query = `
[out:json][timeout:90];
area["name"="Barueri"]["boundary"="administrative"]->.barueri;
(
  relation["type"="route"]["route"="bus"](area.barueri);
  node["highway"="bus_stop"](area.barueri);
  node["public_transport"="platform"]["bus"="yes"](area.barueri);
);
out body;
>;
out skel qt;
`;

const endpoints = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.nchc.org.tw/api/interpreter",
];

let payload;
let errors = [];
for (const endpoint of endpoints) {
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        "user-agent": "VAI-Mobilidade/1.0 (Barueri public transit integration)",
      },
      body: new URLSearchParams({ data: query }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    payload = await response.json();
    break;
  } catch (error) {
    errors.push(`${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (!payload) throw new Error(`All Overpass endpoints failed: ${errors.join("; ")}`);

const elements = payload.elements ?? [];
const nodes = elements.filter((e) => e.type === "node");
const ways = elements.filter((e) => e.type === "way");
const relations = elements.filter((e) => e.type === "relation");
const nodeById = new Map(nodes.map((node) => [node.id, node]));
const stops = nodes
  .filter((node) => node.tags?.highway === "bus_stop" ||
    (node.tags?.public_transport === "platform" && node.tags?.bus === "yes"))
  .map((node) => ({
    id: String(node.id),
    name: node.tags?.name ?? null,
    ref: node.tags?.ref ?? null,
    latitude: node.lat,
    longitude: node.lon,
    tags: node.tags ?? {},
  }));

const routes = relations
  .filter((relation) => relation.tags?.route === "bus")
  .map((relation) => ({
    id: String(relation.id),
    ref: relation.tags?.ref ?? null,
    name: relation.tags?.name ?? null,
    operator: relation.tags?.operator ?? null,
    network: relation.tags?.network ?? null,
    from: relation.tags?.from ?? null,
    to: relation.tags?.to ?? null,
    tags: relation.tags ?? {},
    members: (relation.members ?? []).map((member) => {
      if (member.type === "node") {
        const node = nodeById.get(member.ref);
        return {
          type: member.type,
          role: member.role,
          ref: String(member.ref),
          name: node?.tags?.name ?? null,
          latitude: node?.lat ?? null,
          longitude: node?.lon ?? null,
          tags: node?.tags ?? {},
        };
      }
      return { type: member.type, role: member.role, ref: String(member.ref) };
    }),
  }));

const result = {
  schemaVersion: 1,
  source: "OpenStreetMap Overpass API",
  generatedAt: new Date().toISOString(),
  area: "Barueri, SP, Brazil",
  counts: {
    elements: elements.length,
    nodes: nodes.length,
    ways: ways.length,
    relations: relations.length,
    busRoutes: routes.length,
    busStopNodes: stops.length,
  },
  routes,
  stops,
  diagnostics: {
    overpassEndpoint: endpoints.find((endpoint) => !errors.some((entry) => entry.startsWith(endpoint))) ?? null,
    failedEndpoints: errors,
  },
};

const outputPath = "artifacts/api-server/src/data/barueri-osm-bus-network.json";
await mkdir("artifacts/api-server/src/data", { recursive: true });
await writeFile(outputPath, JSON.stringify(result, null, 2) + "\n", "utf8");

console.log(JSON.stringify(result.counts));
console.log(`Saved ${outputPath}`);
