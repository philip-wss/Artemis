package de.tum.cit.aet.artemis.globalsearch.service.migration;

import java.io.IOException;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import io.weaviate.client6.v1.api.WeaviateClient;

/**
 * V0 → V1 migration: drops the {@code Exercises} and {@code SearchableEntities} collections
 * so that {@link de.tum.cit.aet.artemis.globalsearch.service.WeaviateService} recreates them
 * with the correct schema on the next startup pass (e.g. with trigram tokenization for
 * typo/prefix-tolerant BM25 search).
 * <p>
 * This migration does not move any data. All indexed content will be re-indexed
 * automatically as entities are updated after the restart.
 */
public class V0ToV1Migration implements WeaviateMigration {

    private static final Logger log = LoggerFactory.getLogger(V0ToV1Migration.class);

    static final String SEARCHABLE_ENTITIES_COLLECTION = "SearchableEntities";

    public static final String LEGACY_EXERCISES_COLLECTION = "Exercises";

    @Override
    public int targetVersion() {
        return 1;
    }

    @Override
    public String description() {
        return "Drop Exercises and SearchableEntities collections to force recreation with updated schema";
    }

    @Override
    public void migrate(WeaviateClient client, String collectionPrefix) throws IOException {
        dropIfExists(client, collectionPrefix + LEGACY_EXERCISES_COLLECTION);
        dropIfExists(client, collectionPrefix + SEARCHABLE_ENTITIES_COLLECTION);
    }

    private void dropIfExists(WeaviateClient client, String collectionName) throws IOException {
        if (client.collections.exists(collectionName)) {
            log.info("V0→V1: Dropping collection '{}'", collectionName);
            client.collections.delete(collectionName);
        }
        else {
            log.debug("V0→V1: Collection '{}' does not exist, skipping", collectionName);
        }
    }
}
