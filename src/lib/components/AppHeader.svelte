<script lang="ts">
  import { page } from '$app/stores';

  const navLinks = [
    { href: '/', label: 'Home' },
    { href: '/software', label: 'Software' },
    { href: '/docs', label: 'Docs' },
    { href: '/pricing', label: 'Pricing' },
    { href: '/faq', label: 'FAQ' },
    { href: '/support-seamer', label: 'Support Us' },
    { href: '/about', label: 'About' }
  ];

  let mobileMenuOpen = $state(false);
</script>

<div class="topNav sticky bg-base-100/50 top-0 z-[100] border-b-2 border-accent overflow-visible backdrop-blur-md">
  <div class="max-w-screen-2xl mx-auto px-0 lg:px-10 flex flex-row items-stretch overflow-visible">
    <div class="flex-initial lg:hidden">
      <button
        aria-label="Main menu"
        class="btn btn-ghost btn-circle lg:hidden mx-2"
        onclick={() => mobileMenuOpen = !mobileMenuOpen}
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h7" />
        </svg>
      </button>
      <ul class="menu menu-lg dropdown-content bg-base-100 z-[101] absolute left-0 mt-[2px] w-[100vw] md:w-80 p-0 shadow {mobileMenuOpen ? '' : 'hidden'}">
        {#each navLinks as link}
          <li>
            <a class="p-4 rounded-none" class:active={$page.url.pathname === link.href} href={link.href}>
              <b>{link.label}</b>
            </a>
          </li>
        {/each}
      </ul>
    </div>

    <div class="flex-1 lg:flex-initial text-center lg:text-left flex items-center">
      <a href="/" class="btn btn-ghost text-xl logo">
        <span class="font-lexend font-semibold text-lg">Seamer</span>
      </a>
    </div>

    <div class="hidden lg:flex flex-1 items-center justify-center">
      <ul class="menu menu-horizontal px-1">
        {#each navLinks as link}
          <li>
            <a class:active={$page.url.pathname === link.href} href={link.href}><b>{link.label}</b></a>
          </li>
        {/each}
      </ul>
    </div>

    <div class="flex-initial flex items-center gap-2 pr-2">
      <a href="/studio" class="btn btn-accent btn-sm">Open Studio</a>
    </div>
  </div>
</div>
