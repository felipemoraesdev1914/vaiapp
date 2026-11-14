import { mkdir, writeFile } from "node:fs/promises";

const bbox = "-23.553318,-46.965401,-23.470356,-46.798735";
// Queries are kept small and bounded to Barueri to avoid Overpass area-index scans.
const queries = [
  `[out:json][timeout:75];
  relation["type"="route"]["route"="bus"](${bbox});
  out body;
  >;
  out skel qt;`,
  `[out:json][timeout:75];
  (
    node["highway"="bus_stop"](${bbox});
    node["public_transport"="platform"]["bus"="yes"](${bbox});
    node["public_transport"="platform"]["highway"="bus_stop"](${bbox});
  );
  out body;`,
];

const endpoints = [
  "https://overpass.private.coffee/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
  "https://overpass-api.de/api/interpreter",
];

async function fetchQuery(query, label) {
  const errors = [];
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
          "user-agent": "VAI-Mobilidade/1.0 (Barueri public transit research)",
        },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(95_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      return { endpoint, payload };
    } catch (error) {
      errors.push(`${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`${label}: all Overpass endpoints failed: ${errors.join("; ")}`);
}

const routeResult = await fetchQuery(queries[0], "Bus route relations");
console.log(`Bus relations query succeeded via ${routeResult.endpoint}`);
const stopResult = await fetchQuery(queries[1], "Bus stops");
console.log(`Bus stops query succeeded via ${stopResult.endpoint}`);

const routeElements = routeResult.payload.elements ?? [];
const stopElements = stopResult.payload.elements ?? [];
const allElements = new Map();
for (const element of [...routeElements, ...stopElements]) {
  allElements.set(`${element.type}/${element.id}`, element);
}

const nodes = [...allElements.values()].filter((e) => e.type === "node");
const nodeById = new Map(nodes.map((node) => [node.id, node]));
const stops = stopElements
  .filter((node) => node.type === "node")
  .map((node) => ({
    id: String(node.id),
    name: node.tags?.name ?? null,
    ref: node.tags?.ref ?? null,
    latitude: node.lat,
    longitude: node.lon,
    tags: node.tags ?? {},
  }));

const ways = [...allElements.values()].filter((e) => e.type === "way");
const relations = routeElements
  .filter((relation) => relation.type === "relation" && relation.tags?.route === "bus")
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

const waysById = new Map(ways.map((way) => [way.id, way]));
for (const relation of relations) {
  relation.members = relation.members.map((member) => {
    if (member.type !== "way") return member;
    const way = waysById.get(Number(member.ref));
    return {
      ...member,
      nodeRefs: (way?.nodes ?? []).map(String),
      tags: way?.tags ?? {},
      coordinates: (way?.nodes ?? [])
        .map((nodeId) => nodeById.get(nodeId))
        .filter((node) => Number.isFinite(node?.lat) && Number.isFinite(node?.lon))
        .map((node) => [node.lon, node.lat]),
    };
  });
}

const output = {
  schemaVersion: 1,
  source: "OpenStreetMap Overpass API",
  generatedAt: new Date().toISOString(),
  area: "Barueri, SP, Brazil (bounding box query; may include boundary-edge features)",
  bbox: [-23.553318, -46.965401, -23.470356, -46.798735],
  queryEndpoints: { routes: routeResult.endpoint, stops: stopResult.endpoint },
  counts: {
    routeQueryElements: routeElements.length,
    stopQueryElements: stopElements.length,
    uniqueElements: allElements.size,
    nodes: nodes.length,
    ways: ways.length,
    busRoutes: relations.length,
    busStopNodes: stops.length,
  },
  routes: relations,
  stops,
};

const outputPath = "artifacts/api-server/src/data/barueri-osm-bus-network.json";
await mkdir("artifacts/api-server/src/data", { recursive: true });
await writeFile(outputPath, JSON.stringify(output, null, 2) + "\n", "utf8");
console.log(JSON.stringify(output.counts));
console.log(`Saved ${outputPath}`);
