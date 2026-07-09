const samples = {
  cute: 'мгм, я рядом. увидела новость и почему-то сразу подумала о тебе)',
  calm: 'Я посмотрела каналы. Есть пара важных новостей, могу коротко пересказать.',
  playful: 'так, у меня мини-сводка. без занудства, обещаю)',
  serious: 'Есть новые сообщения из каналов. Могу дать краткий дайджест по фактам.'
};

document.querySelectorAll('.style-switcher button').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.style-switcher button').forEach((item) => item.classList.remove('active'));
    button.classList.add('active');
    document.querySelector('#styleSample p').textContent = samples[button.dataset.style];
  });
});

const observer = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible');
      observer.unobserve(entry.target);
    }
  });
}, { threshold: 0.12 });

document.querySelectorAll('.reveal').forEach((element) => observer.observe(element));

document.querySelectorAll('a[href^="#"]').forEach((link) => {
  link.addEventListener('click', (event) => {
    const target = document.querySelector(link.getAttribute('href'));
    if (!target) return;
    event.preventDefault();
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});
