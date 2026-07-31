import { defineConfig } from 'vitepress';

// Project pages live at https://<user>.github.io/cod/. Override for a custom
// domain or a fork with a different repo name.
const base = process.env.DOCS_BASE ?? '/cod/';

export default defineConfig({
  base,
  lang: 'en-US',
  title: 'Operation Blackout',
  description:
    'A browser first-person shooter in Three.js with zero binary assets — every mesh, texture, sound and animation is generated in code.',
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: true,

  head: [
    ['meta', { name: 'theme-color', content: '#0b0e14' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'Operation Blackout' }],
    [
      'meta',
      {
        property: 'og:description',
        content:
          'A browser FPS in Three.js with no binary assets — all geometry, PBR textures, audio and animation are authored in code.',
      },
    ],
  ],

  themeConfig: {
    nav: [
      // VitePress prepends `base` to internal links, so this must be
      // base-relative: it resolves to <base>play/.
      { text: 'Play', link: '/play/', target: '_self' },
      { text: 'Architecture', link: '/ARCHITECTURE' },
      { text: 'Netcode', link: '/NETCODE' },
      { text: 'Session', link: '/SESSION' },
      { text: 'Visual bar', link: '/VISUAL-BAR' },
      {
        text: 'Contributing',
        link: 'https://github.com/kvnloo/cod/blob/main/CONTRIBUTING.md',
      },
    ],

    sidebar: [
      {
        text: 'Start here',
        items: [
          { text: 'Overview', link: '/' },
          { text: 'Architecture', link: '/ARCHITECTURE' },
        ],
      },
      {
        text: 'Contracts',
        items: [
          { text: 'Netcode', link: '/NETCODE' },
          { text: 'Session & meta', link: '/SESSION' },
        ],
      },
      {
        text: 'Standards',
        items: [{ text: 'The visual bar', link: '/VISUAL-BAR' }],
      },
    ],

    socialLinks: [{ icon: 'github', link: 'https://github.com/kvnloo/cod' }],

    search: { provider: 'local' },

    editLink: {
      pattern: 'https://github.com/kvnloo/cod/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2026 Kevin Rajan',
    },
  },
});
