<template>
  <page-${page}></page-${page}>
</template>
<script>
  window.app = this;

  this.dependencies = [
    // 'page-404',
    'page-home',
    'page-login',
    // 'page-portfolios',
    'page-register',
  ];

  this.route = {
    "/"          : "home",
    "/login"     : "login",
    // "/portfolios": "portfolios",
    "/register"  : "register",
  };

  this.page = Object.keys(this.route).reduce((a,route) => {
    a[this.route[route]] = route;
    return a;
  },{});

  // Returns named fields from 
  this.formData = form => {
    return Array.from(form.querySelectorAll('[name]')).reduce((r,el) => {
      const path    = el.getAttribute('name').split('.');
      const lastkey = path.pop();
      let   ref     = r;
      while(path.length) {
        const key = path.shift();
        ref = ref[key] = ref[key] || {};
      }
      switch(el.getAttribute('type')) {
        case 'checkbox':
          ref[lastkey] = !!el.checked;
          break;
        default:
          if ((el.tagName == 'SELECT') && el.hasAttribute('multiple')) {
            ref[lastkey] = [...el.selectedOptions].map(option => option.value);
          } else {
            ref[lastkey] = el.value;
          }
          break;
      }
      return r;
    }, {});
  };

  this.state = {
    page: 'loading',
  };

  // Handle routing
  if (this.route[document.location.pathname]) {
    this.state.page = this.route[document.location.pathname];
  }

</script>
