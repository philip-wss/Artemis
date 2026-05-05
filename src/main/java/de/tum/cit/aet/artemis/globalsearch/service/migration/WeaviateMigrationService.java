package de.tum.cit.aet.artemis.globalsearch.service.migration;

import java.io.IOException;
import java.util.List;
import java.util.Map;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Conditional;
import org.springframework.context.annotation.Lazy;
import org.springframework.stereotype.Service;

import de.tum.cit.aet.artemis.globalsearch.config.WeaviateConfigurationProperties;
import de.tum.cit.aet.artemis.globalsearch.config.WeaviateEnabled;
import de.tum.cit.aet.artemis.globalsearch.exception.WeaviateException;
import io.weaviate.client6.v1.api.WeaviateApiException;
import io.weaviate.client6.v1.api.WeaviateClient;
import io.weaviate.client6.v1.api.collections.Property;
import io.weaviate.client6.v1.api.collections.VectorConfig;

/**
 * Manages Weaviate schema versioning and runs pending migrations at startup.
 * <p>
 * Schema version is tracked in a dedicated {@code SchemaVersion} Weaviate collection
 * with a single object holding the current version number. Migrations are numbered
 * sequentially (v0 → v1, v1 → v2, …) and applied in order.
 * <p>
 * The service distinguishes two startup scenarios:
 * <ol>
 * <li><b>Fresh install</b> — no version collection and no legacy {@code Exercises}
 * collection exist → version is set to {@link #LATEST_VERSION}, no migrations run.</li>
 * <li><b>Existing deployment</b> — version collection exists, or the legacy {@code Exercises}
 * collection is present → migrations run from the stored version up to {@link #LATEST_VERSION}.</li>
 * </ol>
 */
@Lazy
@Service
@Conditional(WeaviateEnabled.class)
public class WeaviateMigrationService {

    private static final Logger log = LoggerFactory.getLogger(WeaviateMigrationService.class);

    static final String VERSION_COLLECTION_BASE_NAME = "SchemaVersion";

    static final String SCHEMA_VERSION_PROPERTY = "schema_version";

    private static final String VERSION_OBJECT_UUID = "00000000-0000-0000-0000-000000000001";

    /**
     * All registered migrations in ascending target-version order.
     * To add a new migration, append it to this list.
     */
    static final List<WeaviateMigration> MIGRATIONS = List.of(new V0ToV1Migration());

    static final int LATEST_VERSION = MIGRATIONS.getLast().targetVersion();

    private final WeaviateClient client;

    private final String collectionPrefix;

    public WeaviateMigrationService(WeaviateClient client, WeaviateConfigurationProperties properties) {
        this.client = client;
        this.collectionPrefix = properties.collectionPrefix();
    }

    /**
     * Runs all pending migrations. Must be called after all data collections have been
     * created by {@link de.tum.cit.aet.artemis.globalsearch.service.WeaviateService#initializeCollections()}.
     *
     * @throws WeaviateException if any migration fails
     */
    public void runPendingMigrations() {
        try {
            ensureVersionCollectionExists();
            int currentVersion = detectCurrentVersion();

            if (currentVersion >= LATEST_VERSION) {
                log.debug("Weaviate schema is up-to-date (version {})", currentVersion);
                return;
            }

            int pendingCount = (int) MIGRATIONS.stream().filter(m -> m.targetVersion() > currentVersion).count();
            log.info("Weaviate schema version is {}, latest is {}. Running {} pending migration(s)...", currentVersion, LATEST_VERSION, pendingCount);

            for (WeaviateMigration migration : MIGRATIONS) {
                if (migration.targetVersion() <= currentVersion) {
                    continue;
                }
                log.info("Running migration v{} → v{}: {}", migration.targetVersion() - 1, migration.targetVersion(), migration.description());
                migration.migrate(client, collectionPrefix);
                storeVersion(migration.targetVersion());
                log.info("Migration v{} → v{} completed", migration.targetVersion() - 1, migration.targetVersion());
            }

            log.info("All Weaviate migrations completed. Schema is now at version {}", LATEST_VERSION);
        }
        catch (Exception e) {
            log.error("Weaviate migration failed: {}", e.getMessage(), e);
            throw new WeaviateException("Weaviate migration failed: " + e.getMessage(), e);
        }
    }

    /**
     * Detects the current schema version.
     * <ul>
     * <li>If the version collection has an object → return the stored version.</li>
     * <li>If empty and the legacy {@code Exercises} collection exists → v0 deployment, return 0.</li>
     * <li>If empty and no legacy collections → fresh install, store and return {@link #LATEST_VERSION}.</li>
     * </ul>
     */
    private int detectCurrentVersion() throws IOException {
        var versionCollection = client.collections.use(collectionPrefix + VERSION_COLLECTION_BASE_NAME);
        var result = versionCollection.query.fetchObjects(builder -> builder.limit(1));
        if (!result.objects().isEmpty()) {
            Object raw = result.objects().getFirst().properties().get(SCHEMA_VERSION_PROPERTY);
            if (raw instanceof Number number) {
                return number.intValue();
            }
        }

        if (client.collections.exists(collectionPrefix + V0ToV1Migration.LEGACY_EXERCISES_COLLECTION)) {
            log.info("Detected existing deployment with '{}' collection — treating as schema v0", collectionPrefix + V0ToV1Migration.LEGACY_EXERCISES_COLLECTION);
            storeVersion(0);
            return 0;
        }

        log.info("Fresh Weaviate installation detected, setting schema version to {}", LATEST_VERSION);
        storeVersion(LATEST_VERSION);
        return LATEST_VERSION;
    }

    private void ensureVersionCollectionExists() throws IOException {
        String name = collectionPrefix + VERSION_COLLECTION_BASE_NAME;
        if (client.collections.exists(name)) {
            return;
        }
        try {
            client.collections.create(name, config -> {
                config.vectorConfig(VectorConfig.selfProvided());
                config.properties(Property.integer(SCHEMA_VERSION_PROPERTY));
                return config;
            });
            log.info("Created schema version tracking collection '{}'", name);
        }
        catch (WeaviateApiException e) {
            if (e.getMessage() != null && e.getMessage().contains("already exists")) {
                log.debug("Version collection '{}' was created concurrently, ignoring", name);
            }
            else {
                throw e;
            }
        }
    }

    private void storeVersion(int version) throws IOException {
        var versionCollection = client.collections.use(collectionPrefix + VERSION_COLLECTION_BASE_NAME);
        Map<String, Object> props = Map.of(SCHEMA_VERSION_PROPERTY, version);
        try {
            if (versionCollection.data.exists(VERSION_OBJECT_UUID)) {
                versionCollection.data.replace(VERSION_OBJECT_UUID, r -> r.properties(props));
            }
            else {
                versionCollection.data.insert(props, r -> r.uuid(VERSION_OBJECT_UUID));
            }
        }
        catch (WeaviateApiException e) {
            if (e.getMessage() != null && e.getMessage().contains("already exists")) {
                versionCollection.data.replace(VERSION_OBJECT_UUID, r -> r.properties(props));
            }
            else {
                throw e;
            }
        }
    }
}
