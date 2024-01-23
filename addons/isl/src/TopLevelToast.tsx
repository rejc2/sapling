/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {AnimatedReorderGroup} from './AnimatedReorderGroup';
import {toastQueueAtom, useShowToast} from './toast';
import {useRecoilValue} from 'recoil';

import './TopLevelToast.css';
import './Tooltip.css';

export function TopLevelToast() {
  const toast = useShowToast();
  const toastQueue = useRecoilValue(toastQueueAtom);

  const toastDivs = toastQueue.toArray().map(t => {
    const handleClick = () => toast.hide([t.key]);
    return (
      <div className="toast tooltip" key={t.key} data-reorder-id={t.key} onClick={handleClick}>
        {t.message}
      </div>
    );
  });

  return <AnimatedReorderGroup className="toast-container">{toastDivs}</AnimatedReorderGroup>;
}
