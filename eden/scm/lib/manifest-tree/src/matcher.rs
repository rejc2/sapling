/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This software may be used and distributed according to the terms of the
 * GNU General Public License version 2.
 */

use std::sync::Arc;

use anyhow::Result;
use manifest::FsNodeMetadata::Directory;
use manifest::FsNodeMetadata::File;
use manifest::Manifest;
use pathmatcher::DirectoryMatch;
use pathmatcher::Matcher;
use types::RepoPath;

use crate::TreeManifest;

pub struct ManifestMatcher {
    manifest: Arc<TreeManifest>,
    case_sensitive: bool,
}

impl ManifestMatcher {
    pub fn new(manifest: Arc<TreeManifest>, case_sensitive: bool) -> Self {
        ManifestMatcher {
            manifest,
            case_sensitive,
        }
    }
}

impl Matcher for ManifestMatcher {
    fn matches_directory(&self, path: &RepoPath) -> Result<DirectoryMatch> {
        let result = if self.case_sensitive {
            self.manifest.get(path)?
        } else {
            self.manifest.get_ignore_case(path)?
        };
        Ok(match result {
            Some(File(_)) => DirectoryMatch::Nothing,
            Some(Directory(_)) => DirectoryMatch::ShouldTraverse,
            None => DirectoryMatch::Nothing,
        })
    }

    fn matches_file(&self, path: &RepoPath) -> Result<bool> {
        let result = if self.case_sensitive {
            self.manifest.get(path)?
        } else {
            self.manifest.get_ignore_case(path)?
        };
        Ok(match result {
            Some(File(_)) => true,
            Some(Directory(_)) => false,
            None => false,
        })
    }
}
