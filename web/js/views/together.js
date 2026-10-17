// The Together tab: start a session, answer invitations, and see who's
// listening and what's coming up.
import { app } from '../state.js';
import { player } from '../player.js';
import { together } from '../together.js';
import { navigate, popOverlay } from '../router.js';
import { h, append, icon, iconButton, art, avatar, pageHeader, sectionHeader, spinner, emptyState, errorState, toast, sheet, fmt } from '../ui.js';
import { trackRow } from '../components.js';
import { openNowPlaying } from '../nowplaying.js';

const HOW = [
  ['together', 'Invite Plex friends', 'Choose friends you’ve shared this music library with in Plex. They open this same player and sign in with their own Plex account.'],
  ['play', 'Everyone hears the same thing', 'Play, pause, skips and seeks happen for everyone, at the same moment.'],
  ['queue', 'One queue for all', 'Anyone in the session can add tracks with Play next or Add to queue, and remove what’s coming up.'],
];

export async function togetherView({ el, params, onDispose }) {
  el.append(pageHeader('Play Together'));
  const body = h('div.together');
  el.append(body);

  if (!app.config.together) {
    body.append(emptyState('Play Together is turned off on this player. Whoever runs it can turn it on with the PLAY_TOGETHER setting.'));
    return;
  }

  let renderToken = 0;
  let stale = false; // something changed while the page was hidden or under a sheet
  const render = async () => {
    const mine = ++renderToken;
    if (!el.isConnected) {
      stale = true;
      return;
    }
    if (together.active) {
      if (params.session && params.session !== together.session.id) navigate('/together', { replace: true });
      body.replaceChildren(sessionPage());
      return;
    }
    body.replaceChildren(spinner('Checking for invitations'));
    try {
      await together.refresh();
    } catch (err) {
      if (mine !== renderToken) return;
      body.replaceChildren(errorState(problem(err), render));
      return;
    }
    if (mine !== renderToken || together.active) return;
    body.replaceChildren(lobby(params.session));
  };

  // Re-render on changes (from what's already known: no new requests). While
  // the page is kept off screen (another tab) or a sheet is open over it, it
  // catches up once it's back.
  const onChange = () => {
    if (!el.isConnected || document.querySelector('.sheet.open')) {
      stale = true;
      return;
    }
    stale = false;
    if (together.active) refreshSession(body);
    else body.replaceChildren(lobby(params.session));
  };
  const onStatus = () => el.isConnected && updateStatus(body);
  together.addEventListener('change', onChange);
  together.addEventListener('invites', onChange);
  together.addEventListener('status', onStatus);
  together.addEventListener('blocked', onStatus);
  const ticker = setInterval(() => {
    if (!el.isConnected) return;
    if (stale) onChange();
    else updateClock(body);
  }, 1000);
  function cleanup() {
    together.removeEventListener('change', onChange);
    together.removeEventListener('invites', onChange);
    together.removeEventListener('status', onStatus);
    together.removeEventListener('blocked', onStatus);
    clearInterval(ticker);
  }
  onDispose(cleanup);
  await render();
}

function problem(err) {
  if (err.status === 401) return 'Plex didn’t accept your sign-in for Play Together. Play Together needs a Plex account sign-in, so try signing out and in again with Plex.';
  if (err.status === 404) return 'Play Together isn’t available on this player.';
  if (err.network) return 'Can’t reach this player’s server. Check your connection.';
  return err.message;
}

// ---------- lobby ----------

function lobby(highlight) {
  const frag = h('div');
  const invites = together.invites;
  const elsewhere = together.elsewhere;
  if (highlight && !invites.some((s) => s.id === highlight) && !elsewhere.some((s) => s.id === highlight)) {
    frag.append(h('p.together-note.warn', null, 'That invitation has ended, or it isn’t for this Plex account.'));
  }
  if (invites.length) {
    frag.append(sectionHeader('Invitations'), h('div.together-cards', null, invites.map((s) => inviteCard(s, s.id === highlight))));
  }
  if (elsewhere.length) {
    frag.append(sectionHeader('Your sessions'), h('div.together-cards', null, elsewhere.map((s) => rejoinCard(s))));
  }
  frag.append(
    h(
      'section.together-start',
      null,
      h('div.together-hero-icon', null, icon('together', 40)),
      h('h2', null, 'Listen with friends'),
      h('p', null, 'Start a session and invite Plex friends. Everyone hears the same music, in sync, wherever they are.'),
      h('button.btn.btn-primary', { type: 'button', onclick: () => startFlow() }, icon('plus', 20), h('span', null, 'Start a session')),
    ),
    h(
      'ul.together-how',
      null,
      HOW.map(([ic, title, text]) => h('li', null, h('span.tile.tile-plain', null, icon(ic, 22)), h('div', null, h('strong', null, title), h('p', null, text)))),
    ),
    h(
      'p.together-note',
      null,
      `Everyone needs access to ${app.source.sectionTitle} on ${app.source.serverName || 'this Plex server'} (shared with them in Plex), and to open this player (${location.host}) and sign in with their own Plex account.`,
    ),
  );
  return frag;
}

function playingLine(s) {
  if (!s.nowPlaying) return 'Nothing playing yet';
  return `${s.playing ? 'Playing' : 'Paused on'} “${s.nowPlaying.title}”${s.nowPlaying.artist ? ` by ${s.nowPlaying.artist}` : ''}`;
}

function sessionCard(s, { title, actions, highlight }) {
  return h(
    `article.together-card${highlight ? '.highlight' : ''}`,
    null,
    h('div.together-card-top', null, avatar(s.host.thumb, s.host.title), h('div.together-card-text', null, h('div.together-card-title', null, title), h('div.together-card-sub', null, playingLine(s)), h('div.together-card-sub', null, `${s.server.sectionTitle} on ${s.server.name} · ${fmt.count(s.members.length, 'person', 'people')} listening`))),
    h('div.together-card-actions', null, actions),
  );
}

function inviteCard(s, highlight) {
  const join = h('button.btn.btn-primary', { type: 'button' }, icon('play', 18), h('span', null, 'Join'));
  const no = h('button.btn.btn-secondary', { type: 'button' }, 'No thanks');
  join.addEventListener('click', async () => {
    join.disabled = no.disabled = true;
    try {
      await together.join(s.id);
      navigate('/together', { replace: true });
    } catch (err) {
      toast(problem(err), { timeout: 7000 });
      join.disabled = no.disabled = false;
    }
  });
  no.addEventListener('click', async () => {
    join.disabled = no.disabled = true;
    try {
      await together.decline(s.id);
    } catch (err) {
      toast(problem(err));
      join.disabled = no.disabled = false;
    }
  });
  return sessionCard(s, { title: `${s.host.title} invited you`, actions: [join, no], highlight });
}

function rejoinCard(s) {
  const back = h('button.btn.btn-primary', { type: 'button' }, 'Rejoin');
  back.addEventListener('click', async () => {
    back.disabled = true;
    try {
      await together.join(s.id);
    } catch (err) {
      toast(problem(err), { timeout: 7000 });
      back.disabled = false;
    }
  });
  return sessionCard(s, { title: s.role === 'host' ? 'Your session' : `${s.host.title}’s session`, actions: [back] });
}

// ---------- starting and inviting ----------

async function startFlow() {
  const chosen = await pickFriends({
    title: 'Start a session',
    subtitle: `Invite friends to listen to ${app.source.sectionTitle} with you.`,
    confirm: 'Start session',
    offerQueue: !!player.current,
  });
  if (!chosen) return;
  try {
    await together.start({ invite: chosen.ids, withQueue: chosen.withQueue });
    toast(chosen.ids.length ? `Session started. ${fmt.count(chosen.ids.length, 'invitation', 'invitations')} sent.` : 'Session started. Invite friends any time.');
  } catch (err) {
    toast(problem(err), { timeout: 7000 });
  }
}

async function inviteFlow() {
  const s = together.session;
  const exclude = new Set([...s.members.map((m) => m.id), ...s.invited.map((m) => m.id)]);
  const chosen = await pickFriends({ title: 'Invite friends', confirm: 'Send invitations', exclude });
  if (!chosen?.ids.length) return;
  try {
    await together.invite(chosen.ids);
    toast(`${fmt.count(chosen.ids.length, 'invitation', 'invitations')} sent.`);
  } catch (err) {
    toast(problem(err));
  }
}

// Resolves to { ids, withQueue }, or null if closed without choosing.
function pickFriends({ title, subtitle, confirm, offerQueue = false, exclude = new Set() }) {
  return new Promise((resolve) => {
    let result = null;
    const chosen = new Set();
    const list = h('div.friend-list', null, spinner('Loading your Plex friends'));
    const withQueue = h('input.switch', { type: 'checkbox', role: 'switch', checked: true });
    const go = h('button.btn.btn-primary.friend-go', { type: 'button' }, confirm);
    go.addEventListener('click', () => {
      result = { ids: [...chosen], withQueue: offerQueue && withQueue.checked };
      popOverlay();
    });
    const content = h(
      'div.friend-picker',
      null,
      subtitle ? h('p.friend-intro', null, subtitle) : null,
      list,
      offerQueue ? h('label.row.toggle-row.friend-queue', null, h('div.row-main', null, h('div.row-title', null, 'Start with what’s playing'), h('div.row-sub', null, player.current ? `“${player.current.title}” and what’s up next` : '')), withQueue) : null,
      h('div.friend-actions', null, go),
    );
    sheet({ title, content, onClose: () => resolve(result) });

    together
      .friends()
      .then((friends) => {
        const available = friends.filter((f) => !exclude.has(f.id));
        if (!available.length) {
          list.replaceChildren(h('p.friend-empty', null, friends.length ? 'All your Plex friends are already here or invited.' : 'No Plex friends yet. Friends you share your library with in Plex show up here.'));
          return;
        }
        const server = app.source.serverName;
        available.sort((a, b) => (b.canPlay === true) - (a.canPlay === true) || a.title.localeCompare(b.title));
        list.replaceChildren(
          ...available.map((f) => {
            const box = h('input.friend-check', { type: 'checkbox', disabled: f.canPlay === false, 'aria-label': `Invite ${f.title}` });
            box.addEventListener('change', () => (box.checked ? chosen.add(f.id) : chosen.delete(f.id)));
            const sub = f.canPlay === false ? `Can’t play from ${server}` : f.canPlay === null ? `Needs access to ${server}` : f.home ? 'Plex Home' : 'Can join';
            return h(`label.friend${f.canPlay === false ? '.disabled' : ''}`, null, avatar(f.thumb, f.title), h('span.friend-text', null, h('span.friend-name', null, f.title), h('span.friend-sub', null, sub)), box);
          }),
        );
      })
      .catch((err) => list.replaceChildren(h('p.friend-empty.warn', null, problem(err))));
  });
}

// ---------- in a session ----------

function sessionPage() {
  const s = together.session;
  const wrap = h('div.together-session');
  wrap.append(
    h('div.together-status', null, h('span.live-dot'), h('span.together-status-text')),
    nowCard(),
    h('section.block.together-people'),
    h('section.block.together-queue'),
    h('section.block.together-activity'),
  );
  fillSession(wrap);
  updateStatus(wrap);
  return wrap;
}

function refreshSession(body) {
  const wrap = body.querySelector('.together-session');
  if (!wrap) {
    body.replaceChildren(sessionPage());
    return;
  }
  fillSession(wrap);
  updateStatus(wrap);
}

function nowCard() {
  const playBtn = iconButton('play', 'Play', () => player.toggle(), { size: 30, cls: 'together-play' });
  return h(
    'section.together-now',
    null,
    h('button.together-now-main', { type: 'button', onclick: () => openNowPlaying(), 'aria-label': 'Open now playing' }, h('div.together-now-art'), h('div.together-now-text', null, h('div.together-now-title'), h('div.together-now-sub'), h('div.together-now-time'))),
    playBtn,
  );
}

function fillSession(wrap) {
  const s = together.session;
  if (!s) return;
  const cur = s.queue[s.index];
  const nowArt = wrap.querySelector('.together-now-art');
  const thumb = cur?.thumb || '';
  if (nowArt.dataset.thumb !== thumb) {
    nowArt.dataset.thumb = thumb;
    nowArt.replaceChildren(art(cur?.thumb, { size: 96, fallback: 'note' }));
  }
  wrap.querySelector('.together-now-title').textContent = cur ? cur.title : 'Nothing playing';
  wrap.querySelector('.together-now-sub').textContent = cur ? [cur.artist, cur.addedBy && `added by ${cur.addedBy.title}`].filter(Boolean).join(' · ') : 'Add music with Play next or Add to queue.';
  const playBtn = wrap.querySelector('.together-play');
  const playing = s.playing;
  playBtn.replaceChildren(icon(playing ? 'pause' : 'play', 30));
  playBtn.setAttribute('aria-label', playing ? 'Pause for everyone' : 'Play for everyone');
  playBtn.title = playBtn.getAttribute('aria-label');
  updateClock(wrap);

  // People
  const people = wrap.querySelector('.together-people');
  const isHost = s.host.id === s.you;
  const rows = [
    ...s.members.map((m) => personRow(m, m.host ? 'Host' : m.here ? 'Listening' : 'Away', isHost && m.id !== s.you)),
    ...s.invited.map((m) => personRow(m, 'Invited', isHost)),
  ];
  people.replaceChildren();
  // The session's buttons, together: invite, copy the link, leave, end.
  append(people, [sectionHeader(`People (${s.members.length})`), h('div.rows', null, rows), sessionActions(s)]);

  // Up next
  const queue = wrap.querySelector('.together-queue');
  const upcoming = s.queue.slice(s.index + 1, s.index + 101);
  const list = h('div.tracks');
  upcoming.forEach((t, i) => {
    const qi = s.index + 1 + i;
    const row = trackRow(t, {
      showArt: true,
      subtitle: [t.artist, t.addedBy && `added by ${t.addedBy.id === s.you ? 'you' : t.addedBy.title}`].filter(Boolean).join(' · '),
      onPlay: () => player.jump(qi),
      queueIndex: qi,
    });
    row.append(iconButton('close', `Remove ${t.title}`, () => player.remove(qi), { size: 20, cls: 'together-remove' }));
    list.append(row);
  });
  queue.replaceChildren(
    sectionHeader(`Up next${upcoming.length ? ` (${s.queue.length - s.index - 1})` : ''}`, null, upcoming.length > 1 ? h('span.together-queue-actions', null, h('button.link-btn', { type: 'button', onclick: () => player.setShuffle(true) }, 'Shuffle'), h('button.link-btn', { type: 'button', onclick: () => player.clearUpcoming() }, 'Clear')) : null),
    upcoming.length ? list : h('p.together-note.pad', null, 'Nothing queued. Anyone in the session can add music from anywhere in the app with Play next or Add to queue.'),
  );

  // Activity
  const activity = wrap.querySelector('.together-activity');
  const events = s.events.slice().reverse().slice(0, 8);
  activity.replaceChildren(
    sectionHeader('Activity'),
    h('ul.together-events', null, events.map((e) => h('li', null, h('span', null, e.text), h('time', null, fmt.ago((e.at - (together.offset || 0)) / 1000))))),
  );
}

function personRow(m, status, canRemove) {
  const isMe = m.id === together.session.you;
  return h(
    'div.row.person',
    null,
    avatar(m.thumb, m.title),
    h('div.row-main', null, h('div.row-title', null, isMe ? `${m.title} (you)` : m.title), h('div.row-sub', null, h(`span.presence.${status.toLowerCase()}`), status)),
    canRemove
      ? iconButton('close', status === 'Invited' ? `Withdraw ${m.title}’s invitation` : `Remove ${m.title}`, async () => {
          try {
            await together.removePerson(m.id);
          } catch (err) {
            toast(problem(err));
          }
        }, { size: 20 })
      : null,
  );
}

function sessionActions(s) {
  const isHost = s.host.id === s.you;
  const link = `${location.origin}${location.pathname}#/together/${s.id}`;
  return h(
    'div.pad.button-row.together-actions',
    null,
    isHost ? h('button.btn.btn-secondary', { type: 'button', onclick: inviteFlow }, icon('plus', 20), h('span', null, 'Invite friends')) : null,
    h(
      'button.btn.btn-secondary',
      {
        type: 'button',
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(link);
            toast('Link copied. Only people you’ve invited can join.');
          } catch {
            sheet({ title: 'Invitation link', content: h('p.pad.selectable', null, link) });
          }
        },
      },
      icon('link', 20),
      h('span', null, 'Copy link'),
    ),
    h('button.btn.btn-secondary', { type: 'button', onclick: () => confirmLeave(isHost) }, icon('signOut', 20), h('span', null, 'Leave')),
    isHost
      ? h(
          'button.btn.btn-secondary.danger',
          {
            type: 'button',
            onclick: () =>
              sheet({
                title: 'End the session for everyone?',
                subtitle: 'Music stops for everyone listening.',
                actions: [{ icon: 'close', label: 'End session', danger: true, onSelect: () => together.end().catch((err) => toast(problem(err))) }],
              }),
          },
          icon('close', 20),
          h('span', null, 'End for everyone'),
        )
      : null,
  );
}

function confirmLeave(isHost) {
  const others = together.session.members.length - 1;
  sheet({
    title: 'Leave the session?',
    subtitle: isHost && others ? 'Someone else becomes the host and the music carries on for them.' : others ? 'The music carries on for everyone else.' : 'You’re the only one here, so the session ends.',
    actions: [{ icon: 'signOut', label: 'Leave', onSelect: () => together.leave() }],
  });
}

function updateClock(root) {
  const s = together.session;
  const el = root.querySelector('.together-now-time');
  if (!s || !el) return;
  const cur = s.queue[s.index];
  el.textContent = cur ? `${fmt.clock(together.expectedMs() / 1000)} / ${fmt.clock((cur.duration || 0) / 1000)}` : '';
}

function updateStatus(root) {
  const el = root.querySelector('.together-status');
  if (!el || !together.session) return;
  const s = together.session;
  el.classList.toggle('warn', together.status === 'reconnecting' || together.blocked);
  el.replaceChildren();
  append(el, [
    h('span.live-dot'),
    h(
      'span.together-status-text',
      null,
      together.status === 'reconnecting'
        ? 'Reconnecting…'
        : together.blocked
          ? 'Your browser is holding the sound back.'
          : `Live${s.host.id === s.you ? ' · you’re the host' : ` · hosted by ${s.host.title}`}`,
    ),
    together.blocked ? h('button.link-btn', { type: 'button', onclick: () => together.listen() }, 'Start listening') : null,
  ]);
}
