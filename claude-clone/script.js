// ── Prompt suggestions by tab ──
const suggestions = {
  write: [
    'Help me develop a unique voice for my audience',
    'Improve my writing style and clarity',
    'Brainstorm creative ideas for my project',
  ],
  learn: [
    'Explain a complex topic in simple terms',
    'Help me make sense of these research ideas',
    'Prepare me for an exam or interview',
  ],
  code: [
    'Debug this code and explain what went wrong',
    'Refactor this function to be more efficient',
    'Write unit tests for my component',
  ],
  analyze: [
    'Summarize this document and extract key points',
    'Help me find patterns in this data',
    'Compare these two approaches and recommend one',
  ],
};

const suggestionsEl = document.getElementById('promptSuggestions');
const promptInput = document.getElementById('promptInput');

function renderSuggestions(tab) {
  suggestionsEl.innerHTML = '';
  suggestions[tab].forEach(text => {
    const btn = document.createElement('button');
    btn.className = 'suggestion-pill';
    btn.textContent = text;
    btn.addEventListener('click', () => {
      promptInput.value = text;
      promptInput.focus();
      autoGrow(promptInput);
    });
    suggestionsEl.appendChild(btn);
  });
}

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    renderSuggestions(tab.dataset.tab);
  });
});

renderSuggestions('write');

// ── Auto-grow textarea ──
function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}
promptInput.addEventListener('input', () => autoGrow(promptInput));

// ── Prompt form submit ──
document.getElementById('promptForm').addEventListener('submit', e => {
  e.preventDefault();
  const val = promptInput.value.trim();
  if (!val) return;
  window.open(`https://claude.ai/new?q=${encodeURIComponent(val)}`, '_blank');
});

// ── Hamburger menu ──
const hamburger = document.getElementById('hamburger');
const navLinks = document.getElementById('navLinks');
hamburger.addEventListener('click', () => {
  navLinks.classList.toggle('open');
});

// ── Scroll fade-in ──
const fadeEls = document.querySelectorAll(
  '.feature-card, .step, .model-card, .testimonial, .section-title, .section-eyebrow'
);
fadeEls.forEach(el => el.classList.add('fade-in'));

const observer = new IntersectionObserver(
  entries => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        e.target.classList.add('visible');
        observer.unobserve(e.target);
      }
    });
  },
  { threshold: 0.12 }
);
fadeEls.forEach(el => observer.observe(el));

// ── Nav scroll shadow ──
window.addEventListener('scroll', () => {
  document.getElementById('nav').style.boxShadow =
    window.scrollY > 10 ? '0 1px 40px rgba(0,0,0,0.5)' : 'none';
});
