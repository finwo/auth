<template>

  <!-- Nav -->
  <nav class="container-fluid">
    <ul>
      <li><a href="./" class="contrast" onclick="event.preventDefault()"><strong>Brand</strong></a></li>
    </ul>
    <ul>
      <li><a href="#" class="contrast" data-theme-switcher="auto">Auto</a></li>
      <li><a href="#" class="contrast" data-theme-switcher="light">Light</a></li>
      <li><a href="#" class="contrast" data-theme-switcher="dark">Dark</a></li>
    </ul>
  </nav><!-- ./ Nav -->

  <!-- Main -->
  <main class="container">
    <article class="grid p0">
      <div class="p2">
        <hgroup>
          <h1>Register</h1>
        </hgroup>
        <form onsubmit="app.register(this);return false;">
          <input type="email" name="email" placeholder="Email" aria-label="Email" autocomplete="email" required onkeyup="app.register_validation(this);">
          <input type="password" name="password" placeholder="Password" aria-label="Password" required onkeyup="app.register_validation(this);">
          <input type="password" name="password-repeat" placeholder="Repeat password" aria-label="Repeat password" required onkeyup="app.register_validation(this);">
          <center>
            <a href="/login">Already have an account</a>
            <br />
            <br />
          </center>
          <button type="submit" class="contrast">Register</button>
        </form>
      </div>
      <div style="background-image:url('https://source.unsplash.com/daily?landscape,sunrise');background-size:cover;"></div>
    </article>
  </main>

</template>
<script>

  app.register_validation = async form => {
    while(form.tagName !== 'FORM') form = form.parentElement;
    const elPass    = form.querySelector('[name=password]');
    const elPassRep = form.querySelector('[name=password-repeat]');
    const data      = app.formData(form);
    if (data['password'] === data['password-repeat']) {
      elPassRep.setCustomValidity('');
    } else {
      elPassRep.setCustomValidity('Passwords do not match');
    }
  };

  app.register = async form => {

    // Check the form
    const valid = app.register_validation(form);
    if (!valid) return form.reportValidity();
    const data = app.formData(form);

    // Generate keypair
    const kp       = await generateKeyPair({ username: data.email, password: data.password });
    const postData = {
      email: data.email,
      pubkey: kp.publicKey.toString('base64'),
      signature: (await kp.sign(data.email)).toString('base64'),
    };

    // Actually register
    const response = await api.auth.register(postData);

    // Handle error
    if ((!response.ok) && response.field) {
      // TODO: handle error without field
      form.querySelector(`[name=${response.field}]`).setCustomValidity(response.message);
      form.reportValidity();
      return setTimeout(() => {
        form.querySelector(`[name=${response.field}]`).setCustomValidity('');
      }, 5000);
    }

    // Success!

    // Store authentication token
    localStorage['auth:email'] = data.email;
    localStorage['auth:kp']    = JSON.stringify(kp);
    localStorage['auth:token'] = response.token;

    /* // Redirect home */
    /* document.location.href = app.page.home; */
  };

</script>
