/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This software may be used and distributed according to the terms of the
 * GNU General Public License version 2.
 */

//! See docs/basename_suffix_skeleton_manifest.md for more information

use std::collections::BTreeMap;
use std::sync::Arc;

use anyhow::Result;
use blobstore::Blobstore;
use blobstore::Storable;
use bytes::Bytes;
use cloned::cloned;
use context::CoreContext;
use derived_data_manager::DerivationContext;
use futures::future::FutureExt;
use itertools::Either;
use manifest::derive_manifest_with_io_sender;
use manifest::Entry;
use manifest::LeafInfo;
use manifest::TreeInfo;
use manifest::TreeInfoSubentries;
use mononoke_types::basename_suffix_skeleton_manifest::BasenameSuffixSkeletonManifest;
use mononoke_types::basename_suffix_skeleton_manifest::BssmDirectory;
use mononoke_types::basename_suffix_skeleton_manifest::BssmEntry;
use mononoke_types::sharded_map::ShardedMapNode;
use mononoke_types::sharded_map::ShardedTrieMap;
use mononoke_types::BasenameSuffixSkeletonManifestId;
use mononoke_types::BlobstoreValue;
use mononoke_types::BonsaiChangeset;
use mononoke_types::ContentId;
use mononoke_types::FileType;
use mononoke_types::NonRootMPath;
use skeleton_manifest::mapping::get_file_changes;

use crate::mapping::RootBasenameSuffixSkeletonManifest;
use crate::path::BssmPath;

/// Calculate a list of changes of the changeset, but putting the basename first and
/// reversing it.
fn get_fixed_up_changes(
    bcs: &BonsaiChangeset,
) -> Vec<(NonRootMPath, Option<(ContentId, FileType)>)> {
    get_file_changes(bcs)
        .into_iter()
        .map(|(path, content)| (BssmPath::transform(path).into_raw(), content))
        .collect()
}

async fn empty_mf(
    ctx: &CoreContext,
    blobstore: &impl Blobstore,
) -> Result<BasenameSuffixSkeletonManifestId> {
    let leaf = BasenameSuffixSkeletonManifest::empty();
    leaf.into_blob().store(ctx, blobstore).await
}

async fn inner_derive(
    ctx: &CoreContext,
    blobstore: &Arc<dyn Blobstore>,
    parents: Vec<BssmDirectory>,
    changes: Vec<(NonRootMPath, Option<(ContentId, FileType)>)>,
) -> Result<Option<BssmDirectory>> {
    // Types to help understand how to use derive_manifest helper
    type Leaf = (ContentId, FileType);
    type LeafId = ();
    type TreeId = BssmDirectory;
    type IntermediateLeafId = LeafId;
    type Ctx = ();
    derive_manifest_with_io_sender(
        ctx.clone(),
        blobstore.clone(),
        parents,
        changes,
        // create_tree
        {
            cloned!(ctx, blobstore);
            move |info: TreeInfo<TreeId, IntermediateLeafId, Ctx, ShardedTrieMap<BssmEntry>>,
                  fut_sender| {
                cloned!(ctx, blobstore);
                async move {
                    let (rollup_count, subentries): (_, BTreeMap<_, _>) = match info.subentries {
                        TreeInfoSubentries::AllSubentries(subentries) => {
                            let mut rollup_count = 0;
                            let subentries = subentries
                                .into_iter()
                                .inspect(|(_path, (_ctx, entry))| match entry {
                                    Entry::Tree(tree) => rollup_count += tree.rollup_count as i64,
                                    Entry::Leaf(_) => rollup_count += 1,
                                })
                                .map(|(path, (_ctx, entry))| {
                                    let entry = match entry {
                                        Entry::Leaf(()) => BssmEntry::File,
                                        Entry::Tree(entry) => BssmEntry::Directory(entry),
                                    };
                                    (Bytes::copy_from_slice(path.as_ref()), Either::Left(entry))
                                })
                                .collect();
                            (rollup_count, subentries)
                        }
                        TreeInfoSubentries::ReusedMapsAndSubentries {
                            produced_subentries_and_reused_maps,
                            consumed_subentries,
                        } => {
                            // The sum of the rollup counts for the parents (-1 to remove the directories of the parents' themselves)
                            // minus the rollup counts for the consumed subentries results in the sum of rollup counts for the reused maps.
                            let mut rollup_count = info
                                .parents
                                .iter()
                                .map(|parent| parent.rollup_count as i64 - 1)
                                .chain(consumed_subentries.into_iter().map(|entry| match entry {
                                    Entry::Tree(tree) => -(tree.rollup_count as i64),
                                    Entry::Leaf(_) => -1,
                                }))
                                .sum();

                            let subentries = produced_subentries_and_reused_maps
                                .into_iter()
                                // Add the rollup counts for all the produced subentries.
                                .inspect(|(_prefix, entry_or_map)| match entry_or_map {
                                    Either::Left((_ctx, Entry::Tree(tree))) => {
                                        rollup_count += tree.rollup_count as i64;
                                    }
                                    Either::Left((_ctx, Entry::Leaf(_))) => {
                                        rollup_count += 1;
                                    }
                                    Either::Right(_map) => {}
                                })
                                .flat_map(|(prefix, entry_or_map)| match entry_or_map {
                                    Either::Left((_maybe_ctx, entry)) => {
                                        let entry = match entry {
                                            Entry::Leaf(()) => BssmEntry::File,
                                            Entry::Tree(entry) => BssmEntry::Directory(entry),
                                        };
                                        vec![(prefix, Either::Left(entry))]
                                    }
                                    Either::Right(map) => match map {
                                        ShardedTrieMap::Edge(edge) => {
                                            vec![(prefix, Either::Right(edge))]
                                        }
                                        ShardedTrieMap::Trie(trie) => trie
                                            .into_iter()
                                            .map(|(mut key, entry)| {
                                                key.insert_from_slice(0, prefix.as_ref());
                                                (key, Either::Left(entry))
                                            })
                                            .collect::<Vec<_>>(),
                                    },
                                })
                                .map(|(key, entry)| (Bytes::copy_from_slice(&key), entry))
                                .collect();
                            (rollup_count, subentries)
                        }
                    };

                    let mf = BasenameSuffixSkeletonManifest {
                        subentries: ShardedMapNode::from_entries(&ctx, &blobstore, subentries)
                            .await?,
                    };

                    let entry = {
                        let blob = mf.into_blob();
                        let id = *blob.id();
                        fut_sender
                            .unbounded_send(
                                async move { blob.store(&ctx, &blobstore).await.map(|_| ()) }
                                    .boxed(),
                            )
                            .map_err(|err| {
                                anyhow::anyhow!("failed to send manifest future {}", err)
                            })?;
                        BssmDirectory {
                            id,
                            rollup_count: (1 + rollup_count) as u64,
                        }
                    };
                    anyhow::Ok(((), entry))
                }
            }
        },
        // create_leaf
        {
            move |_leaf_info: LeafInfo<IntermediateLeafId, Leaf>, _fut_sender| async move {
                anyhow::Ok(((), ()))
            }
        },
    )
    .await
}

pub(crate) async fn derive_single(
    ctx: &CoreContext,
    derivation_ctx: &DerivationContext,
    bonsai: BonsaiChangeset,
    parents: Vec<RootBasenameSuffixSkeletonManifest>,
) -> Result<RootBasenameSuffixSkeletonManifest> {
    let parents = parents.into_iter().map(|root| root.0).collect::<Vec<_>>();
    let changes = get_fixed_up_changes(&bonsai);
    let blobstore = derivation_ctx.blobstore();

    let root = inner_derive(ctx, blobstore, parents, changes).await?;

    Ok(RootBasenameSuffixSkeletonManifest(match root {
        Some(root) => root,
        // Only happens on empty repo
        None => BssmDirectory {
            id: empty_mf(ctx, blobstore).await?,
            rollup_count: 1,
        },
    }))
}
