# Portions Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This software may be used and distributed according to the terms of the
# GNU General Public License version 2.

# changelog bisection for mercurial
#
# Copyright 2007 Olivia Mackall
# Copyright 2005, 2006 Benoit Boissinot <benoit.boissinot@ens-lyon.org>
#
# Inspired by git bisect.
#
# This software may be used and distributed according to the terms of the
# GNU General Public License version 2 or any later version.

from __future__ import absolute_import

import collections
from typing import Optional, Sized

import bindings

from . import error, pycompat
from .i18n import _
from .node import hex, short


def bisect(repo, state):
    """find the next node (if any) for testing during a bisect search.
    returns a (nodes, number, good, badnode, goodnode) tuple, where badnode and
    goodnode - borders of the range.

    'nodes' is the final result of the bisect if 'number' is 0.
    Otherwise 'number' indicates the remaining possible candidates for
    the search and 'nodes' contains the next bisect target.
    'good' is True if bisect is searching for a first good changeset, False
    if searching for a first bad one.
    """
    if repo.ui.configbool("experimental", "bisect2"):
        return _bisect2(repo, state)
    else:
        return _bisect1(repo, state)


def _bisect1(repo, state):
    changelog = repo.changelog
    clparents = changelog.parentrevs
    skip = _state_to_revs(repo, state, "skip")

    def buildancestors(bad, good):
        badrev = min([changelog.rev(n) for n in bad])
        goodrev = max([changelog.rev(n) for n in good])
        ancestors = collections.defaultdict(lambda: None)
        for rev in repo.revs("descendants(%ln) - ancestors(%ln)", good, good):
            ancestors[rev] = []
        if ancestors[badrev] is None:
            return badrev, goodrev, None
        return badrev, goodrev, ancestors

    good = False
    badrev, goodrev, ancestors = buildancestors(state["bad"], state["good"])
    if not ancestors:  # looking for bad to good transition?
        good = True
        badrev, goodrev, ancestors = buildancestors(state["good"], state["bad"])
    bad = changelog.node(badrev)
    if not ancestors:  # now we're confused
        if (
            len(state["bad"]) == 1
            and len(state["good"]) == 1
            and state["bad"] != state["good"]
        ):
            raise error.Abort(_("starting revisions are not directly related"))
        raise error.Abort(
            _("inconsistent state, %s:%s is good and bad") % (badrev, short(bad))
        )

    badnode = changelog.node(badrev)
    goodnode = changelog.node(goodrev)

    # build children dict
    children = {}
    visit = collections.deque([badrev])
    candidates = []
    while visit:
        rev = visit.popleft()
        if ancestors[rev] == []:
            candidates.append(rev)
            for prev in clparents(rev):
                if prev != -1:
                    if prev in children:
                        children[prev].append(rev)
                    else:
                        children[prev] = [rev]
                        visit.append(prev)

    candidates.sort()
    # have we narrowed it down to one entry?
    # or have all other possible candidates besides 'bad' have been skipped?
    tot = len(candidates)
    unskipped = {c for c in candidates if (c not in skip) and (c != badrev)}
    if tot == 1 or not unskipped:
        return ([changelog.node(c) for c in candidates], 0, good, badnode, goodnode)
    unskipped.add(badrev)
    perfect = tot // 2

    # find the best node to test
    best_rev = None
    best_len = -1
    poison = set()
    for rev in candidates:
        if rev in poison:
            # poison children
            poison.update(children.get(rev, []))
            continue

        a = ancestors[rev] or [rev]
        ancestors[rev] = None

        x = len(a)  # number of ancestors
        y = tot - x  # number of non-ancestors
        value = min(x, y)  # how good is this test?
        if value > best_len and rev in unskipped:
            best_len = value
            best_rev = rev
            if value == perfect:  # found a perfect candidate? quit early
                break

        if y < perfect and rev in unskipped:  # all downhill from here?
            # poison children
            poison.update(children.get(rev, []))
            continue

        for c in children.get(rev, []):
            if ancestors[c]:
                ancestors[c] = list(set(ancestors[c] + a))
            else:
                ancestors[c] = a + [c]

    assert best_rev is not None
    best_node = changelog.node(best_rev)

    return ([best_node], tot, good, badnode, goodnode)


def _bisect2(repo, state):
    """bisect algorithm based on segmented changelog"""

    # States:
    # - skip_revs: user provided "skip" revset. Might be expensive/lazy (no fastlen()).
    # - good: marked as good nodes
    # - bad: marked as bad ndoes
    # - badtogood: True if bad is root, good is head; False if bad is head
    # - roots, heads: defines the bisect range based on bad and good
    # - rootnode, headnode: current (small) bisect range, for display only
    # - candidate: bisect range
    # - unskipped: bisect range, excluding "fast" skipped nodes
    # - bestnode: the best node to test next
    cl = repo.changelog
    dag = cl.dag
    skip_revs = _state_to_revs(repo, state, "skip")
    if skip_revs.fastlen() is not None:
        # skip is equvilent to skip_revs
        skip = cl.tonodes(skip_revs)
        skip_needs_extra_check = False
    else:
        # skip_revs might be a large lazy set. We don't want O(skip_revs).
        # skip is not equvilent to skip_revs and needs special handling
        skip = dag.sort([])
        skip_needs_extra_check = True
    good = dag.sort(state["good"])
    bad = dag.sort(state["bad"])

    # bad-to-good: find first good; bad (roots) is not candidate:
    #
    #   C good (candidate)
    #   |
    #   B maybe good (candidate)
    #   |
    #   A bad (NOT candidate)
    #
    # good-to-bad: find first bad; good (roots) is not candidate:
    #
    #   C bad (candidate)
    #   |
    #   B maybe bad (candidate)
    #   |
    #   A good (NOT candidate)
    badtogood = len(dag.only(good, bad)) > 0
    if badtogood:
        roots, heads = bad, good
    else:
        roots, heads = good, bad
    rootnode = roots.first()  # DESC order, first = max
    headnode = heads.last()  # DESC order, last = min
    heads = dag.roots(dag.range(heads, heads))
    roots = dag.headsancestors(roots)
    # see "NOT candidate" above for why "- roots".
    candidate = cl.dageval(lambda: range(roots, heads) - roots)
    total = len(candidate)
    if total == 0:
        if (
            len(state["bad"]) == 1
            and len(state["good"]) == 1
            and state["bad"] != state["good"]
        ):
            raise error.Abort(_("starting revisions are not directly related"))
        raise error.Abort(_("inconsistent state, %s is good and bad") % short(headnode))

    # Here we only skip concrete commits. If "skip" is a lazy set we handle it later
    # to avoid O(skip) or O(candidate) complexity - both of them could be large sets.
    unskipped = candidate - skip

    # got conclusion, or all skipped
    if total == 1 or len(unskipped) == 0:
        return (list(candidate), 0, badtogood, headnode, rootnode)

    # Find a node in "unskipped" that will cut down search in half.
    # The algorithm works similarly to setdiscover.py:
    # 1. pick a node in "remaining"
    #
    #    heads
    #     :
    #    pick
    #     :
    #    roots
    #
    # 2. if "pick" is too closer to "roots", remove "ancestors(pick)"
    #    from "remaining", since they will be worse.
    # 3. if "pick" is too far from "roots" (closer to "heads"), remove
    #    "descendants(pick)" from "remaining", similarily.
    # 4. repeat from 1 until "remaining" is empty or "pick" is perfect.
    perfect = len(unskipped) / 2
    bestdelta = len(unskipped)
    bestnode = unskipped.first()
    remaining = unskipped
    heads = dag.headsancestors(unskipped)
    while len(remaining) > 0:
        node = remaining.skip(len(remaining) // 2).first()
        count = len(dag.ancestors([node]) & remaining)
        delta = abs(count - perfect)
        # update best?
        if delta < bestdelta:
            bestdelta = delta
            bestnode = node
        if delta < 1:
            break
        if count > perfect:
            # skip descendants(node)
            remaining = remaining - dag.range([node], heads)
        else:
            # skip ancestors(node)
            remaining = remaining - dag.ancestors([node])

    # Handle a lazy skip_revs.
    if skip_needs_extra_check:
        # To avoid applying the (potentially slow) lazy skip calculation to the
        # entire "roots::heads" (or "unskipped") set, we test the lazy skip
        # condition around the "bestnode" commit.
        ancestors = dag.ancestors([bestnode]) & unskipped
        not_ancestors = unskipped - ancestors
        zip_set = ancestors.union_zip(not_ancestors.reverse())

        # PERF: We reuse the revset prefetch fields from "skip_revs". This
        # helps reduce round-trips for revset iteration (by look ahead and
        # batch fetch text, hash, associated code review states). However, more
        # complex revsets that need file/tree data (ex. modifies(path)) won't
        # be batched this way. We need new infra to express dynamic, complex
        # prefetch needs.
        bar = bindings.progress.model.ProgressBar(
            _("skipping"), len(unskipped), _("commits")
        )
        inc = bar.increase_position
        for ctx in cl.torevset(zip_set).prefetch(*skip_revs.prefetchfields()).iterctx():
            if ctx.rev() in skip_revs:
                inc(1)
                continue
            bestnode = ctx.node()
            break

    return ([bestnode], total, badtogood, headnode, rootnode)


def checksparsebisectskip(repo, candidatenode, badnode, goodnode) -> str:
    """
    Checks if the candidate node can be skipped as the contents haven't changed
    within the sparse profile.
    goodnode and badnode - borders of the bisect range.

    Returns "good" if the node can be skipped as it's the same as goodnode,
    "bad" if the node can be skipped as it's the same as badnode, "check" otherwise.
    """

    def diffsparsematch(node, diff):
        shouldsparsematch = hasattr(repo, "sparsematch") and (
            "eden" not in repo.requirements or "edensparse" in repo.requirements
        )
        if not shouldsparsematch:
            return True
        rev = repo.changelog.rev(node)
        sparsematch = repo.sparsematch(rev)
        return any(f for f in diff.keys() if sparsematch(f))

    badmanifest = repo[badnode].manifest()
    bestmanifest = repo[candidatenode].manifest()
    goodmanifest = repo[goodnode].manifest()

    baddiff = diffsparsematch(candidatenode, badmanifest.diff(bestmanifest))
    gooddiff = diffsparsematch(candidatenode, bestmanifest.diff(goodmanifest))
    if baddiff and not gooddiff:
        return "good"
    if not baddiff and gooddiff:
        return "bad"

    return "check"


def extendrange(repo, state, nodes, good):
    # bisect is incomplete when it ends on a merge node and
    # one of the parent was not checked.
    parents = repo[nodes[0]].parents()
    if len(parents) > 1:
        if good:
            side = state["bad"]
        else:
            side = state["good"]
        num = len(set(i.node() for i in parents) & set(side))
        if num == 1:
            return parents[0].ancestor(parents[1])
    return None


def load_state(repo):
    state = {"current": [], "good": [], "bad": [], "skip": []}
    for l in repo.localvfs.tryreadlines("bisect.state"):
        l = pycompat.decodeutf8(l)
        kind, node = l[:-1].split(" ", 1)
        if kind not in state:
            raise error.Abort(_("unknown bisect kind %s") % kind)
        node = node if node.startswith("revset:") else repo.lookup(node)
        state[kind].append(node)
    return state


def save_state(repo, state) -> None:
    f = repo.localvfs("bisect.state", "wb", atomictemp=True)
    with repo.wlock():
        for kind in sorted(state):
            for node in state[kind]:
                s = hex(node) if isinstance(node, bytes) else node
                f.writeutf8("%s %s\n" % (kind, s))
        f.close()


def resetstate(repo) -> None:
    """remove any bisect state from the repository"""
    if repo.localvfs.exists("bisect.state"):
        repo.localvfs.unlink("bisect.state")


def checkstate(state) -> bool:
    """check we have both 'good' and 'bad' to define a range

    Raise Abort exception otherwise."""
    if state["good"] and state["bad"]:
        return True
    if not state["good"]:
        raise error.Abort(_("cannot bisect (no known good revisions)"))
    else:
        raise error.Abort(_("cannot bisect (no known bad revisions)"))


def _state_to_revs(repo, state, kind):
    items = state[kind]
    nodes = []
    revset_exprs = []

    for item in items:
        if isinstance(item, bytes):
            nodes.append(item)
        elif item.startswith("revset:"):
            revset_exprs.append(item[7:])
        else:
            raise error.Abort(_("invalid node: %s, kind: %s") % (item, kind))

    return repo.revs("%ln or %lr", nodes, revset_exprs)


def get(repo, status):
    """
    Return a list of revision(s) that match the given status:

    - ``good``, ``bad``, ``skip``: csets explicitly marked as good/bad/skip
    - ``goods``, ``bads``      : csets topologically good/bad
    - ``range``              : csets taking part in the bisection
    - ``pruned``             : csets that are goods, bads or skipped
    - ``untested``           : csets whose fate is yet unknown
    - ``ignored``            : csets ignored due to DAG topology
    - ``current``            : the cset currently being bisected
    """
    state = load_state(repo)
    if status in ("good", "bad", "skip", "current"):
        return list(_state_to_revs(repo, state, status))
    else:
        # In the following sets, we do *not* call 'bisect()' with more
        # than one level of recursion, because that can be very, very
        # time consuming. Instead, we always develop the expression as
        # much as possible.

        # 'range' is all csets that make the bisection:
        #   - have a good ancestor and a bad descendant, or conversely
        # that's because the bisection can go either way
        range = "( bisect(bad)::bisect(good) | bisect(good)::bisect(bad) )"

        _t = repo.revs("bisect(good)::bisect(bad)")
        # The sets of topologically good or bad csets
        if len(_t) == 0:
            # Goods are topologically after bads
            goods = "bisect(good)::"  # Pruned good csets
            bads = "::bisect(bad)"  # Pruned bad csets
        else:
            # Goods are topologically before bads
            goods = "::bisect(good)"  # Pruned good csets
            bads = "bisect(bad)::"  # Pruned bad csets

        # 'pruned' is all csets whose fate is already known: good, bad, skip
        skips = "bisect(skip)"  # Pruned skipped csets
        pruned = "( (%s) | (%s) | (%s) )" % (goods, bads, skips)

        # 'untested' is all cset that are- in 'range', but not in 'pruned'
        untested = "( (%s) - (%s) )" % (range, pruned)

        # 'ignored' is all csets that were not used during the bisection
        # due to DAG topology, but may however have had an impact.
        # E.g., a branch merged between bads and goods, but whose branch-
        # point is out-side of the range.
        iba = "::bisect(bad) - ::bisect(good)"  # Ignored bads' ancestors
        iga = "::bisect(good) - ::bisect(bad)"  # Ignored goods' ancestors
        ignored = "( ( (%s) | (%s) ) - (%s) )" % (iba, iga, range)

        if status == "range":
            return repo.revs(range)
        elif status == "pruned":
            return repo.revs(pruned)
        elif status == "untested":
            return repo.revs(untested)
        elif status == "ignored":
            return repo.revs(ignored)
        elif status == "goods":
            return repo.revs(goods)
        elif status == "bads":
            return repo.revs(bads)
        else:
            raise error.ParseError(_("invalid bisect state"))


def label(repo, node) -> Optional[str]:
    rev = repo.changelog.rev(node)

    # Try explicit sets
    if rev in get(repo, "good"):
        # i18n: bisect changeset status
        return _("good")
    if rev in get(repo, "bad"):
        # i18n: bisect changeset status
        return _("bad")
    if rev in get(repo, "skip"):
        # i18n: bisect changeset status
        return _("skipped")
    if rev in get(repo, "untested") or rev in get(repo, "current"):
        # i18n: bisect changeset status
        return _("untested")
    if rev in get(repo, "ignored"):
        # i18n: bisect changeset status
        return _("ignored")

    # Try implicit sets
    if rev in get(repo, "goods"):
        # i18n: bisect changeset status
        return _("good (implicit)")
    if rev in get(repo, "bads"):
        # i18n: bisect changeset status
        return _("bad (implicit)")

    return None


def shortlabel(label):
    if label:
        return label[0].upper()

    return None


def printresult(ui, repo, state, displayer, nodes: Sized, good) -> None:
    if len(nodes) == 1:
        # narrowed it down to a single revision
        if good:
            ui.write(_("The first good revision is:\n"))
        else:
            ui.write(_("The first bad revision is:\n"))
        # pyre-fixme[16]: `Sized` has no attribute `__getitem__`.
        displayer.show(repo[nodes[0]])
        extendnode = extendrange(repo, state, nodes, good)
        if extendnode is not None:
            ui.write(
                _(
                    "Not all ancestors of this changeset have been"
                    " checked.\nUse bisect --extend to continue the "
                    "bisection from\nthe common ancestor, %s.\n"
                )
                % extendnode
            )
    else:
        # multiple possible revisions
        if good:
            ui.write(
                _(
                    "Due to skipped revisions, the first "
                    "good revision could be any of:\n"
                )
            )
        else:
            ui.write(
                _(
                    "Due to skipped revisions, the first "
                    "bad revision could be any of:\n"
                )
            )
        # pyre-fixme[16]: `Sized` has no attribute `__iter__`.
        for n in nodes:
            displayer.show(repo[n])
    displayer.close()
