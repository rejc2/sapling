/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {ReactNode} from 'react';
import type {ReactProps} from './utils';

import {cn} from 'shared/cn';
import {Icon} from './Icon';
import css from './Tag.module.css';

export function Tag({
  className,
  icon = null,
  children,
  ...rest
}: {
  children: ReactNode;
  icon?: null | React.ComponentProps<typeof Icon>['icon'];
  className?: string;
} & ReactProps<HTMLSpanElement>) {
  if (icon != null) {
    return (
      <span className={(css.tag, css.flex, className)} {...rest}>
        <Icon size="S" icon={icon} className={css.icon} />
        <span className={css.text}>{children}</span>
      </span>
    );
  } else {
    return (
      <span className={cn(css.tag, css.text, className)} {...rest}>
        {children}
      </span>
    );
  }
}
