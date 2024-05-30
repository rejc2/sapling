# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed according to the terms of the
# GNU General Public License found in the LICENSE file in the root
# directory of this source tree.

  $ . "${TEST_FIXTURES}/library.sh"

Setup a Mononoke repo.

  $ setup_common_config blob_files
  $ cd "$TESTTMP"

Start Mononoke & LFS.

  $ start_and_wait_for_mononoke_server
Create a repo

  $ hgmn_init repo
  $ cd repo
  $ echo first > file
  $ hg add file
  $ hg commit -m "first"
  $ echo second >> file
  $ hg commit -m "second"
  $ echo third >> file
  $ hg commit -m "third"
  $ cat > file <<EOF
  > first
  > fourth
  > fifth
  > third
  > EOF
  $ hg commit -m "last"

Look at the blame for this file as generated by Mercurial
  $ hg blame -cl file
  e7b1cec8f996:1: first
  4f2c66e5b324:2: fourth
  4f2c66e5b324:3: fifth
  f079f8e6945c:3: third

  $ hgmn push -q --to main --create

Compute the blame directly
  $ mononoke_admin blame compute -l main file
  * using repo "repo" repoid RepositoryId(0) (glob)
  * changeset resolved as: ChangesetId(Blake2(617a81a133c0e681396cf70aa84dd51d12608873febde458a46874e3baa8cd08)) (glob)
     #1 e7b1cec8f996:   1: first
     #4 4f2c66e5b324:   2: fourth
     #4 4f2c66e5b324:   3: fifth
     #3 f079f8e6945c:   3: third
  
Derive the blame
  $ mononoke_admin blame derive -l main file
  * using repo "repo" repoid RepositoryId(0) (glob)
  * changeset resolved as: ChangesetId(Blake2(617a81a133c0e681396cf70aa84dd51d12608873febde458a46874e3baa8cd08)) (glob)
     #1 e7b1cec8f996:   1: first
     #4 4f2c66e5b324:   2: fourth
     #4 4f2c66e5b324:   3: fifth
     #3 f079f8e6945c:   3: third
  
