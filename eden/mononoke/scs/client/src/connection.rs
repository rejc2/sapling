/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This software may be used and distributed according to the terms of the
 * GNU General Public License version 2.
 */

//! Connection management.

use anyhow::Error;
use fbinit::FacebookInit;
use identity::Identity;
use identity::IdentitySet;
use scs_client_raw::ScsClient;
use scs_client_raw::ScsClientBuilder;
use scs_client_raw::SCS_DEFAULT_TIER;

#[derive(clap::Args)]
pub(super) struct ConnectionArgs {
    #[clap(long, default_value = "scsc-default-client", global = true)]
    /// Name of the client for quota attribution and logging.
    client_id: String,
    #[clap(long, short, default_value = SCS_DEFAULT_TIER, global = true)]
    /// Connect to SCS through given tier.
    tier: String,
    #[clap(long, short = 'H', conflicts_with = "tier", global = true)]
    /// Connect to SCS through a given host and port pair, format HOST:PORT.
    host: Option<String>,
    #[clap(long, global = true, hide = true)]
    /// Expected server X509 identities (used only in tests).
    /// Works only with SR thrift client.
    expected_server_identity: Vec<Identity>,
}

impl ConnectionArgs {
    pub fn get_connection(&self, fb: FacebookInit, repo: Option<&str>) -> Result<ScsClient, Error> {
        let mut builder = ScsClientBuilder::new();
        if !self.expected_server_identity.is_empty() {
            let ids = IdentitySet::from_iter(self.expected_server_identity.clone());
            builder = builder.with_expected_identities(ids);
        }
        if let Some(host_port) = &self.host {
            builder.build_from_host_port(fb, host_port)
        } else {
            builder.build_from_tier_name(fb, self.client_id.clone(), &self.tier, repo)
        }
    }
}
