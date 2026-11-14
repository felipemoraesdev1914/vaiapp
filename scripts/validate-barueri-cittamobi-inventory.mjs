import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const path = resolve(process.cwd(), "artifacts/api-server/src/data/barueri-cittamobi-line-inventory.json");
const data = JSON.parse(await readFile(path, "utf8"));
const errors = [];
const categories = ["municipalLineCodes", "intermunicipalLineCodes"];
for (const category of categories) {
  if (!Array.isArray(data[category]) || data[category].length === 0) {
    errors.push(`${category}: lista ausente ou vazia.`);
    continue;
  }
  const normalized = data[category].map((code) => String(code).trim());
  if (normalized.some((code) => !code)) errors.push(`${category}: código vazio.`);
  if (new Set(normalized).size !== normalized.length) errors.push(`${category}: códigos duplicados.`);
}
const all = [...(data.municipalLineCodes ?? []), ...(data.intermunicipalLineCodes ?? [])];
if (new Set(all).size !== all.length) errors.push("Há códigos repetidos entre as categorias.");
if (data.status !== "discovery-inventory-only-not-for-routing") errors.push("Status de segurança inesperado.");
if (!data.source?.pages?.length || data.source.pages.some((url) => !/^https:\/\//.test(url))) errors.push("Fontes HTTPS ausentes ou inválidas.");
if (data.counts?.totalDistinctCodes !== all.length) errors.push("Contagem total divergente.");
if (errors.length) {
  console.error("Validação do inventário de linhas falhou:");
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Inventário válido: ${data.municipalLineCodes.length} códigos municipais + ${data.intermunicipalLineCodes.length} intermunicipais = ${all.length} códigos.`);
  console.log("Inventário de descoberta: não representa itinerários ou paradas validados.");
}
