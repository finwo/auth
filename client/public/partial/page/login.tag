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
          <h1>Sign_in</h1>
        </hgroup>
        <form onsubmit="app.login(this);return false;">
          <input type="email" name="email" placeholder="Email" aria-label="Email" autocomplete="email" required>
          <input type="password" name="password" placeholder="Password" aria-label="Password" autocomplete="current-password" required>
          <fieldset>
            <label for="remember">
              <input type="checkbox" role="switch" id="remember" name="remember" aria-checked="false">
              Remember me
            </label>
          </fieldset>
          <center>
            <a href="/forgot-password">Forgot password</a>
            <br />
            <a href="/register">Create a new account</a>
            <br />
            <br />
          </center>
          <button type="submit" class="contrast">Login</button>
        </form>
      </div>
      <div style="background-image:url('https://source.unsplash.com/daily?landscape,mountains');background-size:cover;"></div>
    </article>
  </main>

</template>
<script>

  app.login = async form => {
    const data = app.formData(form);
    console.log({data});
  };

</script>
