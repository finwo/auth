import type { AdminRealm } from './api';

export interface RealmNavigation {
  visible: boolean;
  label: string;
  href: string;
  isPlural: boolean;
}

export function realmNavigation(
  realms: AdminRealm[] | null,
  canCreateRealm: boolean
): RealmNavigation {
  const realmCount = realms?.length || 0;
  const singleRealmOnly = realmCount === 1 && !canCreateRealm;
  const firstSlug = realms?.[0]?.slug || '';

  return {
    visible: realmCount > 0 || canCreateRealm,
    label: singleRealmOnly ? 'Realm' : 'Realms',
    href: singleRealmOnly
      ? `/settings/${encodeURIComponent(firstSlug)}`
      : '/realms',
    isPlural: !singleRealmOnly,
  };
}

export function realmBreadcrumbItems(
  realms: AdminRealm[] | null,
  canCreateRealm: boolean,
  realmSlug: string
) {
  const navigation = realmNavigation(realms, canCreateRealm);
  return [
    {
      label: navigation.label,
      ...(navigation.isPlural ? { path: '/realms' } : {}),
    },
    { label: realmSlug },
  ];
}
