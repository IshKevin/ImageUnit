export const THEME_KEY = 'imageunit-theme';

/** Runs in <head> before paint. "system" leaves data-theme unset so the CSS media query decides. */
export const THEME_SCRIPT = `try{var t=localStorage.getItem('${THEME_KEY}');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`;
