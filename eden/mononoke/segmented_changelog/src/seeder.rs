/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This software may be used and distributed according to the terms of the
 * GNU General Public License version 2.
 */

use std::sync::Arc;

use anyhow::{Context, Result};
use slog::info;

use sql_ext::replication::ReplicaLagMonitor;
use stats::prelude::*;

use blobstore::Blobstore;
use bookmarks::Bookmarks;
use changeset_fetcher::ChangesetFetcher;
use context::CoreContext;
use mononoke_types::RepositoryId;

use crate::dag::ops::DagAddHeads;
use crate::iddag::IdDagSaveStore;
use crate::idmap::IdMapFactory;
use crate::idmap::SqlIdMapVersionStore;
use crate::parents::FetchParents;
use crate::types::{IdMapVersion, SegmentedChangelogVersion};
use crate::update::{server_namedag, vertexlist_from_seedheads, SeedHead};
use crate::version_store::SegmentedChangelogVersionStore;
use crate::{InProcessIdDag, SegmentedChangelogSqlConnections};

define_stats! {
    prefix = "mononoke.segmented_changelog.seeder";
    build_all_graph: timeseries(Sum),
}

pub struct SegmentedChangelogSeeder {
    idmap_version_store: SqlIdMapVersionStore,
    changeset_fetcher: Arc<dyn ChangesetFetcher>,
    sc_version_store: SegmentedChangelogVersionStore,
    iddag_save_store: IdDagSaveStore,
    idmap_factory: IdMapFactory,
    bookmarks: Arc<dyn Bookmarks>,
}

impl SegmentedChangelogSeeder {
    pub fn new(
        repo_id: RepositoryId,
        connections: SegmentedChangelogSqlConnections,
        replica_lag_monitor: Arc<dyn ReplicaLagMonitor>,
        blobstore: Arc<dyn Blobstore>,
        changeset_fetcher: Arc<dyn ChangesetFetcher>,
        bookmarks: Arc<dyn Bookmarks>,
    ) -> Self {
        let idmap_version_store = SqlIdMapVersionStore::new(connections.0.clone(), repo_id);
        let sc_version_store = SegmentedChangelogVersionStore::new(connections.0.clone(), repo_id);
        let iddag_save_store = IdDagSaveStore::new(repo_id, blobstore);
        let idmap_factory = IdMapFactory::new(connections.0, replica_lag_monitor, repo_id);
        Self {
            idmap_version_store,
            changeset_fetcher,
            sc_version_store,
            iddag_save_store,
            idmap_factory,
            bookmarks,
        }
    }

    pub async fn run(&self, ctx: &CoreContext, heads: Vec<SeedHead>) -> Result<()> {
        let idmap_version = {
            let v = match self
                .idmap_version_store
                .get(&ctx)
                .await
                .context("error fetching idmap version from store")?
            {
                Some(v) => v.0 + 1,
                None => 1,
            };
            IdMapVersion(v)
        };
        self.run_with_idmap_version(ctx, heads, idmap_version).await
    }

    pub async fn run_with_idmap_version(
        &self,
        ctx: &CoreContext,
        heads: Vec<SeedHead>,
        idmap_version: IdMapVersion,
    ) -> Result<()> {
        STATS::build_all_graph.add_value(1);
        info!(
            ctx.logger(),
            "seeding segmented changelog using idmap version: {}", idmap_version
        );

        let idmap = self.idmap_factory.for_writer(ctx, idmap_version);
        let iddag = InProcessIdDag::new_in_process();

        let parents_fetcher = FetchParents::new(ctx.clone(), self.changeset_fetcher.clone());
        // Create a segmented changelog by updating the empty set to a full set
        let mut namedag = server_namedag(ctx.clone(), iddag, idmap)?;
        let heads_with_options =
            vertexlist_from_seedheads(&ctx, &heads, self.bookmarks.as_ref()).await?;
        namedag
            .add_heads(&parents_fetcher, &heads_with_options)
            .await?;

        let (idmap, iddag) = namedag.into_idmap_dag();
        idmap.finish().await?;

        // Update IdMapVersion
        self.idmap_version_store
            .set(&ctx, idmap_version)
            .await
            .context("updating idmap version")?;
        info!(ctx.logger(), "idmap version bumped");

        // Write the IdDag (to BlobStore)
        let iddag_version = self
            .iddag_save_store
            .save(&ctx, &iddag)
            .await
            .context("error saving iddag")?;

        // Update SegmentedChangelogVersion
        let sc_version = SegmentedChangelogVersion::new(iddag_version, idmap_version);
        self.sc_version_store
            .set(&ctx, sc_version)
            .await
            .context("error updating segmented changelog version store")?;
        info!(
            ctx.logger(),
            "successfully finished seeding segmented changelog",
        );
        Ok(())
    }
}
