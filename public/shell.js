(() => {
  const preference = 'mcqq-theme';
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  const narrow = window.matchMedia('(max-width: 780px)');
  let chosenTheme;
  try { chosenTheme = localStorage.getItem(preference); } catch {}

  function applyTheme() {
    const theme = chosenTheme === 'light' || chosenTheme === 'dark'
      ? chosenTheme : system.matches ? 'dark' : 'light';
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#202923' : '#e8ede7');
    const button = document.querySelector('[data-theme-toggle]');
    if (button) {
      const next = theme === 'dark' ? '浅色' : '深色';
      button.querySelector('[data-theme-label]').textContent = next;
      button.setAttribute('aria-label', '切换为' + next + '模式');
    }
  }

  applyTheme();
  system.addEventListener('change', applyTheme);

  const groups = [
    ['概览', [['/', '运行总览', 'grid']]],
    ['配置', [['/settings', '连接设置', 'controls'], ['/templates', '消息模板', 'text'], ['/terminal', 'RCON 终端', 'terminal']]],
    ['玩家', [['/binding-admin', '绑定管理', 'link'], ['/users', 'AQQBot 查询', 'search'], ['/registrations', 'QQ 登记', 'person'], ['/aqqbot-database', 'AQQBot 整库', 'database']]],
    ['日志与扩展', [['/server-logs', '服务器日志', 'log'], ['/player-logs', '玩家命令日志', 'log'], ['/modules', '模块中心', 'box'], ['/guide', '使用教程', 'guide']]]
  ];
  const mobile = [
    ['/', '总览', 'grid', ['/']],
    ['/settings', '连接', 'controls', ['/settings', '/templates']],
    ['/binding-admin', '绑定', 'link', ['/binding-admin', '/users', '/registrations', '/aqqbot-database']],
    ['/server-logs', '日志', 'log', ['/server-logs', '/player-logs']]
  ];

  function icon(name) {
    const item = document.createElement('span');
    item.className = 'nav-icon icon-' + name;
    item.setAttribute('aria-hidden', 'true');
    return item;
  }

  function navLink(path, label, kind) {
    const link = document.createElement('a');
    link.href = path;
    const caption = document.createElement('span');
    caption.textContent = label;
    link.append(icon(kind), caption);
    if (location.pathname === path) link.setAttribute('aria-current', 'page');
    else if (path === '/modules' && location.pathname.startsWith('/modules/')) link.setAttribute('aria-current', 'location');
    return link;
  }

  function fillNav(nav) {
    for (const [label, links] of groups) {
      const group = document.createElement('div');
      group.className = 'nav-group';
      const heading = document.createElement('span');
      heading.className = 'nav-heading';
      heading.textContent = label;
      group.append(heading, ...links.map(link => navLink(...link)));
      nav.append(group);
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    applyTheme();
    document.querySelector('[data-theme-toggle]')?.addEventListener('click', () => {
      chosenTheme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(preference, chosenTheme); } catch {}
      applyTheme();
    });

    const sidebar = document.getElementById('main-nav');
    const bar = document.getElementById('mobile-nav');
    const dialog = document.getElementById('nav-dialog');
    if (!sidebar || !bar || !dialog) return;

    fillNav(sidebar);
    fillNav(dialog.querySelector('nav'));
    for (const [path, label, kind, related] of mobile) {
      const link = navLink(path, label, kind);
      if (related.includes(location.pathname)) link.classList.add('current-section');
      bar.append(link);
    }
    const more = document.createElement('button');
    more.type = 'button';
    more.setAttribute('aria-controls', dialog.id);
    more.setAttribute('aria-haspopup', 'dialog');
    more.setAttribute('aria-expanded', 'false');
    const caption = document.createElement('span');
    caption.textContent = '更多';
    more.append(icon('menu'), caption);
    if (!mobile.some(entry => entry[3].includes(location.pathname))) more.classList.add('current-section');
    bar.append(more);

    more.addEventListener('click', () => {
      dialog.showModal();
      more.setAttribute('aria-expanded', 'true');
    });
    dialog.addEventListener('close', () => more.setAttribute('aria-expanded', 'false'));
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
    narrow.addEventListener('change', event => { if (!event.matches && dialog.open) dialog.close(); });
  });
})();
