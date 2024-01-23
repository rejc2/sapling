/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {CommitInfo, Hash} from './types';

import {useEffect, useState} from 'react';
import {atom, selectorFamily, useSetRecoilState} from 'recoil';

export const highlightedCommits = atom<Set<Hash>>({
  key: 'highlightedCommits',
  default: new Set(),
});

export const isHighlightedCommit = selectorFamily({
  key: 'isHighlightedCommit',
  get:
    (key: string) =>
    ({get}) => {
      const highlighted = get(highlightedCommits);
      return highlighted.has(key);
    },
});

export function HighlightCommitsWhileHovering({
  toHighlight,
  children,
  ...rest
}: {
  toHighlight: Array<CommitInfo | Hash>;
  children: React.ReactNode;
} & React.DetailedHTMLProps<React.HTMLAttributes<HTMLDivElement>, HTMLDivElement>) {
  const setHighlighted = useSetRecoilState(highlightedCommits);
  const [isSourceOfHighlight, setIsSourceOfHighlight] = useState(false);

  useEffect(() => {
    return () => {
      if (isSourceOfHighlight) {
        // if we started the highlight, make sure to unhighlight when unmounting
        setHighlighted(new Set());
      }
    };
  }, [isSourceOfHighlight, setHighlighted]);

  return (
    <div
      {...rest}
      onMouseOver={() => {
        setHighlighted(
          new Set(
            toHighlight.map(commitOrHash =>
              typeof commitOrHash === 'string' ? commitOrHash : commitOrHash.hash,
            ),
          ),
        );
        setIsSourceOfHighlight(true);
      }}
      onMouseOut={() => {
        setHighlighted(new Set());
        setIsSourceOfHighlight(false);
      }}>
      {children}
    </div>
  );
}
