# VAI — Mobilidade Inteligente

Planejador de mobilidade mobile-first para Barueri, SP, com mapa OpenStreetMap, busca Photon e rotas programadas do GTFS metropolitano da ARTESP.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the shared API server (port 8080)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/vai-mobilidade/` — aplicação web React + Vite do VAI
- `artifacts/vai-mobilidade/src/components/PhotonAutocomplete.tsx` — busca de endereços com Photon
- `artifacts/vai-mobilidade/src/components/MapCanvas.tsx` — mapa interativo e marcadores de origem/destino
- `artifacts/api-server/` — API Node.js compartilhada, incluindo busca de rotas com GTFS
- `lib/api-spec/openapi.yaml` — contrato OpenAPI compartilhado e origem dos tipos/hooks

## Architecture decisions

- O frontend usa tiles OpenStreetMap e Photon; o backend baixa o GTFS publicado pela ARTESP e consulta caminhos a pé pelo serviço público FOSSGIS baseado em OSM.
- O GTFS da ARTESP contém linhas metropolitanas com paradas na região de Barueri, mas não contém a malha completa de linhas municipais da cidade.
- Exibir somente linhas, paradas, horários e geometrias presentes nas fontes reais; nunca inventar transporte ou previsões em tempo real.
- O feed não publica exceções de feriados em `calendar_dates.txt` e a ARTESP informa interpolação de parte dos horários em `stop_times.txt`.
- O roteador público de caminhada recebe coordenadas de origem/destino e pode não oferecer disponibilidade garantida.

## Product

- Busca de endereços reais para origem e destino, troca de pontos e acesso à localização atual do usuário.
- Mapa interativo OpenStreetMap centrado inicialmente em Barueri, com geometrias GTFS e trechos de caminhada OSM.
- Busca de viagens futuras com até uma baldeação, filtros por tempo/caminhada/baldeações e metadados de atualização da fonte.

## User preferences

- Preservar a identidade visual existente em branco, neutros e verde-lima; não introduzir cores novas.
- Não inventar horários ou linhas reais; identificar a cobertura limitada do GTFS e a ausência de serviço em tempo real.

## Gotchas

- As linhas e os horários são GTFS estático da ARTESP (metropolitano); não representam todas as linhas municipais de Barueri nem posições de ônibus em tempo real.
- A localização atual depende da permissão do navegador e de um contexto seguro; tratar recusa e indisponibilidade sem bloquear a busca manual.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
