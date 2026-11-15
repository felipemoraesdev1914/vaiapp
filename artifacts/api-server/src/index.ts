import app from "./app";
import { logger } from "./lib/logger";
import { getArtespGtfsFeed } from "./lib/artespGtfsSource";
import { getBarueriMunicipalGtfsFeed } from "./lib/barueriMunicipalGtfsSource";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  void getArtespGtfsFeed()
    .then((feed) => {
      logger.info(
        {
          version: feed.source.version,
          updatedAt: feed.source.updatedAt,
        },
        "ARTESP GTFS data loaded",
      );
    })
    .catch((error: unknown) => {
      logger.warn(
        { err: error },
        "ARTESP GTFS preload failed; route search will retry on demand",
      );
    });

  void getBarueriMunicipalGtfsFeed()
    .then((feed) => {
      logger.info(
        {
          routes: feed.routes.size,
          stops: feed.stops.size,
          trips: feed.trips.size,
          version: feed.source.version,
        },
        "Barueri municipal transit data loaded",
      );
    })
    .catch((error: unknown) => {
      logger.warn(
        { err: error },
        "Barueri municipal transit preload failed; route search will retry on demand",
      );
    });
});
