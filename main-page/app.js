/* ── Supabase Auth ── */
const SUPABASE_URL  = 'https://dhdzftmlrkuwcsgmgihe.supabase.co';
const SUPABASE_KEY  = 'sb_publishable_9Ns_telLHzlI-qwxJ_-XbQ_u_9Sab3J';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

let authTab = 'login';

async function checkSession() {
  const { data: { session } } = await sb.auth.getSession();
  if (session?.user) showUser(session.user);
  else showGuest();
}

function getFirstName(user) {
  const meta = user.user_metadata;
  if (meta?.full_name) return meta.full_name.split(' ')[0];
  if (meta?.name)      return meta.name.split(' ')[0];
  return (user.email || '').split('@')[0];
}

function showUser(user) {
  document.getElementById('guestBar').style.display = 'none';
  document.getElementById('userBar').style.display  = '';
  const name = getFirstName(user);
  document.getElementById('userFirstName').textContent = name;
  document.getElementById('userAvatar').textContent    = name[0]?.toUpperCase() || 'A';
}
function showGuest() {
  document.getElementById('guestBar').style.display = '';
  document.getElementById('userBar').style.display  = 'none';
}

window.openAuthModal  = () => document.getElementById('authOverlay').classList.add('show');
window.closeAuthModal = () => {
  document.getElementById('authOverlay').classList.remove('show');
  document.getElementById('authErr').classList.remove('show');
};
window.switchAuthTab  = function(tab) {
  authTab = tab;
  const isSignup = tab === 'signup';
  document.getElementById('tabLogin').classList.toggle('active',  !isSignup);
  document.getElementById('tabSignup').classList.toggle('active', isSignup);
  document.getElementById('authSubmit').textContent = isSignup ? 'Create Account' : 'Sign In';
  document.getElementById('nameRow').style.display    = isSignup ? '' : 'none';
  document.getElementById('confirmRow').style.display = isSignup ? '' : 'none';
  document.getElementById('authErr').classList.remove('show');
};

window.doAuth = async function() {
  const email     = document.getElementById('authEmail').value.trim();
  const password  = document.getElementById('authPassword').value;
  const btn       = document.getElementById('authSubmit');
  const errEl     = document.getElementById('authErr');
  const isSignup  = authTab === 'signup';

  errEl.classList.remove('show');
  if (!email || !password) { errEl.textContent = 'Enter your email and password.'; errEl.classList.add('show'); return; }

  if (isSignup) {
    const firstName = document.getElementById('authFirstName').value.trim();
    const lastName  = document.getElementById('authLastName').value.trim();
    const confirm   = document.getElementById('authConfirm').value;
    if (!firstName) { errEl.textContent = 'Enter your first name.'; errEl.classList.add('show'); return; }
    if (password !== confirm) { errEl.textContent = 'Passwords do not match.'; errEl.classList.add('show'); return; }
    if (password.length < 6)  { errEl.textContent = 'Password must be at least 6 characters.'; errEl.classList.add('show'); return; }

    btn.disabled = true; btn.textContent = '…';
    const fullName = `${firstName} ${lastName}`.trim();
    const r = await sb.auth.signUp({ email, password, options: { data: { full_name: fullName, first_name: firstName, last_name: lastName } } });
    const error = r.error;
    btn.disabled = false; btn.textContent = 'Create Account';
    if (!error && r.data?.user && !r.data.session) {
      errEl.style.background = 'rgba(16,185,129,.12)'; errEl.style.borderColor = 'rgba(16,185,129,.2)'; errEl.style.color = '#34d399';
      errEl.textContent = `Account created! Check ${email} to confirm, then sign in.`;
      errEl.classList.add('show'); return;
    }
    if (!error && r.data.session) { showUser(r.data.session.user); closeAuthModal(); return; }
    if (error) { errEl.style.background=''; errEl.style.borderColor=''; errEl.style.color=''; errEl.textContent = error.message; errEl.classList.add('show'); }
    return;
  }

  // Sign in
  btn.disabled = true; btn.textContent = '…';
  const r = await sb.auth.signInWithPassword({ email, password });
  btn.disabled = false; btn.textContent = 'Sign In';
  if (r.error) {
    errEl.style.background=''; errEl.style.borderColor=''; errEl.style.color='';
    errEl.textContent = r.error.message; errEl.classList.add('show');
  } else {
    showUser(r.data.user); closeAuthModal();
  }
};

window.signOut = async function() {
  await sb.auth.signOut();
  showGuest();
};

// Close modal on overlay click
document.getElementById('authOverlay').addEventListener('click', e => {
  if (e.target === document.getElementById('authOverlay')) closeAuthModal();
});

sb.auth.onAuthStateChange((_event, session) => {
  if (session?.user) showUser(session.user);
  else showGuest();
});

checkSession();

/* ── Stars ── */
(function createStars() {
  const c = document.getElementById('stars');
  for (let i = 0; i < 150; i++) {
    const s = document.createElement('div');
    s.className = 'star';
    const size = Math.random() * 2.8 + 0.4;
    s.style.cssText = `width:${size}px;height:${size}px;top:${Math.random()*100}%;left:${Math.random()*100}%;--d:${2+Math.random()*5}s;--delay:${Math.random()*5}s`;
    c.appendChild(s);
  }
})();

/* ── 3D mouse-tilt on cards ── */
document.querySelectorAll('.tool-card:not(.soon)').forEach(card => {
  card.addEventListener('mousemove', e => {
    const r = card.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width  - 0.5;
    const y = (e.clientY - r.top)  / r.height - 0.5;
    card.style.transform = `translateY(-14px) rotateX(${-y * 12}deg) rotateY(${x * 12}deg)`;
  });
  card.addEventListener('mouseleave', () => { card.style.transform = ''; });
});

/* ── Animate stat numbers counting up ── */
function countUp(el, target, duration) {
  const start = performance.now();
  const isNum = !isNaN(target);
  function step(now) {
    const p    = Math.min((now - start) / duration, 1);
    const ease = 1 - Math.pow(1 - p, 3);
    el.textContent = isNum ? Math.round(ease * target) : '∞';
    if (p < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

const observer = new IntersectionObserver(entries => {
  entries.forEach(e => {
    if (!e.isIntersecting) return;
    document.querySelectorAll('.stat-num').forEach(el => {
      const t = el.textContent.trim();
      if (t === '∞') return;
      countUp(el, parseInt(t), 1200);
    });
    observer.disconnect();
  });
}, { threshold: 0.5 });

const statsRow = document.querySelector('.stats-row');
if (statsRow) observer.observe(statsRow);

/* ── Cross-domain SSO: pass session tokens when opening tools ── */
document.querySelectorAll('.tool-card:not(.soon)').forEach(card => {
  card.addEventListener('click', async e => {
    e.preventDefault();
    const href = card.getAttribute('href');
    try {
      const { data: { session } } = await sb.auth.getSession();
      if (session?.access_token) {
        window.location.href = href + '#access_token=' + encodeURIComponent(session.access_token) + '&refresh_token=' + encodeURIComponent(session.refresh_token) + '&token_type=bearer';
        return;
      }
    } catch {}
    window.location.href = href;
  });
});

/* ── Stagger card entrance animation ── */
const cards = document.querySelectorAll('.tool-card');
cards.forEach((card, i) => {
  card.style.opacity = '0';
  card.style.transform = 'translateY(40px)';
  card.style.transition = 'opacity .6s ease, transform .6s cubic-bezier(.23,1,.32,1)';
  setTimeout(() => {
    card.style.opacity = '';
    card.style.transform = '';
  }, 100 + i * 80);
});
