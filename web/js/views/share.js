// Sharing a playlist with Plex friends (see sharing.js): who it's shared
// with, and whether each can edit it (for everyone) or only view and play
// it; and the playlists shared with you, to add or turn down.
import { app } from '../state.js';
import { h, sheet, toast, avatar, fmt, confirmAction, row, iconTile } from '../ui.js';
import { navigate } from '../router.js';
import { friends, sharePlaylist, setMembers, stopSharing, shareOf, addShared, declineShared, leaveShared } from '../sharing.js';

const ROLES = [
  ['', 'Not shared'],
  ['view', 'Can view'],
  ['edit', 'Can edit'],
];

const names = (list) => (list.length < 3 ? list.join(' and ') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`);

// "Shared with Sam and Alex (invited)", or "Shared by Dan · you can edit it".
export function shareLine(share) {
  if (!share) return '';
  if (share.role === 'owner') {
    const who = (share.members || []).map((m) => (m.joined ? m.title : `${m.title} (invited)`));
    return who.length ? `Shared with ${names(who)}` : 'Shared';
  }
  return `Shared by ${share.owner.title} · you can ${share.role === 'edit' ? 'edit it' : 'view it, not edit it'}`;
}

// Who it's shared with, and how: a playlist of yours.
export function openShareDialog(pl, { onChange } = {}) {
  // The server it's on: the one in use now.
  const server = app.source.serverId;
  const share = shareOf(pl.ratingKey);
  const mine = share?.role === 'owner' ? share : null;
  const had = new Map((mine?.members || []).map((m) => [m.id, m]));
  const picks = new Map(); // friend id -> its <select>
  const list = h('div.friend-list', null, h('p.friend-empty', null, 'Loading your Plex friends…'));
  const go = h('button.btn.btn-primary', { type: 'button', disabled: true }, mine ? 'Save' : 'Share');
  const stop = mine ? h('button.link-btn.danger.share-stop', { type: 'button' }, 'Stop sharing') : null;
  const intro = mine
    ? 'Everyone it’s shared with has a copy of their own, kept the same as yours. Anyone who can edit it changes it for everyone.'
    : 'Each friend gets a copy of their own, in plexamp-web, kept the same as yours. Anyone who can edit it changes it for everyone.';
  const box = sheet({
    title: mine ? `Sharing “${pl.title}”` : `Share “${pl.title}”`,
    content: h('div.friend-picker.share-picker', null, h('p.friend-intro', null, intro), list, h('div.friend-actions', null, go, stop)),
  });

  const chosen = () =>
    [...picks.entries()].map(([id, sel]) => ({ id, role: sel.value })).filter((m) => m.role);
  const paint = () => {
    const n = chosen().length;
    go.disabled = !mine && !n;
    go.textContent = mine ? 'Save' : n ? `Share with ${fmt.count(n, 'friend', 'friends')}` : 'Share';
  };

  friends()
    .then((all) => {
      if (!all.length) {
        list.replaceChildren(h('p.friend-empty', null, 'No Plex friends yet. Friends you share your library with in Plex show up here.'));
        return;
      }
      const serverName = app.source.serverName;
      all.sort((a, b) => !!had.get(b.id) - !!had.get(a.id) || (b.canPlay !== false) - (a.canPlay !== false) || a.title.localeCompare(b.title));
      list.replaceChildren(
        ...all.map((f) => {
          const m = had.get(f.id);
          const sel = h('select.share-role', { 'aria-label': `${f.title}: what they can do` }, ...ROLES.map(([v, label]) => h('option', { value: v }, label)));
          sel.value = m?.role || '';
          // Friends who can't use this server couldn't play it.
          sel.disabled = f.canPlay === false && !m;
          sel.addEventListener('change', paint);
          picks.set(f.id, sel);
          const sub = m
            ? m.joined
              ? 'Has added it'
              : 'Invited: hasn’t added it yet'
            : f.canPlay === false
              ? `Can’t play from ${serverName}`
              : f.canPlay === null
                ? `Needs access to ${serverName}`
                : f.home
                  ? 'Plex Home'
                  : `Can play from ${serverName}`;
          return h(`div.friend.share-friend${sel.disabled ? '.disabled' : ''}`, null, avatar(f.thumb, f.title), h('span.friend-text', null, h('span.friend-name', null, f.title), h('span.friend-sub', null, sub)), sel);
        }),
      );
      paint();
    })
    .catch((err) => list.replaceChildren(h('p.friend-empty.warn', null, err.message)));

  go.addEventListener('click', async () => {
    const members = chosen();
    go.disabled = true;
    try {
      if (mine && !members.length) {
        await stopSharing(mine);
        toast(`“${pl.title}” isn’t shared any more. Everyone keeps their copy.`);
      } else if (mine) {
        await setMembers(mine, members);
        toast(`Saved: “${pl.title}” is shared with ${fmt.count(members.length, 'friend', 'friends')}`);
      } else {
        await sharePlaylist(pl, members, { server });
        toast(`Shared “${pl.title}”. ${members.length === 1 ? 'Your friend finds it' : 'Your friends find it'} in Playlists, in plexamp-web.`, { timeout: 6000 });
      }
      box.close();
      onChange?.();
    } catch (err) {
      toast(err.message);
      paint();
    }
  });

  stop?.addEventListener('click', async () => {
    const sure = await confirmAction({
      title: `Stop sharing “${pl.title}”?`,
      message: 'Everyone keeps their copy, as a playlist of their own. Changes stop going between them.',
      confirm: 'Stop sharing',
    });
    if (!sure) return;
    try {
      await stopSharing(mine);
      toast(`“${pl.title}” isn’t shared any more`);
      box.close();
      onChange?.();
    } catch (err) {
      toast(err.message);
    }
  });
}

// One shared with you, from its page: it stops being shared with you.
export async function leaveDialog(share, { onChange } = {}) {
  const sure = await confirmAction({
    title: `Stop getting “${share.title}” from ${share.owner.title}?`,
    message: 'You keep it, as a playlist of your own, but changes stop going between you.',
    confirm: 'Stop sharing it with me',
  });
  if (!sure) return;
  try {
    await leaveShared(share);
    toast(`“${share.title}” is a playlist of your own now`);
    onChange?.();
  } catch (err) {
    toast(err.message);
  }
}

// Playlists shared with you, not added yet: a row each, to add or turn
// down. onChange() after either.
export function invitationRows(list, { onChange } = {}) {
  return list.map((s) => {
    const add = h('button.btn.btn-primary.btn-small', { type: 'button' }, 'Add');
    const no = h('button.btn.btn-secondary.btn-small', { type: 'button' }, 'No thanks');
    const r = row({
      lead: iconTile('together'),
      title: s.title,
      subtitle: `From ${s.owner.title} · ${fmt.count(s.count, 'track', 'tracks')} · you can ${s.role === 'edit' ? 'edit it' : 'view it'}`,
      right: h('div.invite-actions', null, add, no),
      cls: 'invite-row',
    });
    add.addEventListener('click', async () => {
      add.disabled = no.disabled = true;
      add.textContent = 'Adding…';
      try {
        const pl = await addShared(s);
        toast(`Added “${s.title}” to your playlists`, { action: 'Open', onAction: () => navigate(`/playlist/${pl.ratingKey}`) });
        onChange?.();
      } catch (err) {
        toast(err.message);
        add.disabled = no.disabled = false;
        add.textContent = 'Add';
      }
    });
    no.addEventListener('click', async () => {
      add.disabled = no.disabled = true;
      try {
        await declineShared(s);
        onChange?.();
      } catch (err) {
        toast(err.message);
        add.disabled = no.disabled = false;
      }
    });
    return r;
  });
}
