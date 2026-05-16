function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
}

function openModal(id) {
  document.getElementById(id).classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeModal(id) {
  document.getElementById(id).classList.remove('active');
  document.body.style.overflow = '';
}

document.addEventListener('click', function(e) {
  const sidebar = document.getElementById('sidebar');
  const toggle = document.querySelector('.menu-toggle');
  if (window.innerWidth <= 768 && sidebar && sidebar.classList.contains('open')) {
    if (!sidebar.contains(e.target) && e.target !== toggle) {
      sidebar.classList.remove('open');
    }
  }
});

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal.active').forEach(m => m.classList.remove('active'));
    document.body.style.overflow = '';
  }
});

document.querySelectorAll('.btn, .action-btn, .btn-small').forEach(btn => {
  btn.addEventListener('touchstart', function() { this.style.opacity = '0.7'; });
  btn.addEventListener('touchend', function() { this.style.opacity = ''; });
});
