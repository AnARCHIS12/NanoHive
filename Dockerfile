# --- stage 1: minify the theme payload ---------------------------------
FROM --platform=$BUILDPLATFORM node:22.14.0-alpine AS themebuild
ARG NH_MINIFY=true
WORKDIR /src
COPY theme/ ./theme/
RUN if [ "$NH_MINIFY" = "true" ]; then \
      npm install --silent --no-audit --no-fund --no-package-lock esbuild@0.24.2 && \
      for f in core.js enhancements.js book-details.js nh-early.js; do \
        hdr=$(head -n 1 "theme/$f" | sed 's|/\*||; s|\*/||; s|^ *||; s| *$||'); \
        printf '/* %s */\n' "$hdr" > "/tmp/banner-$f"; \
        ./node_modules/.bin/esbuild "theme/$f" --minify --target=es2020 --charset=utf8 --legal-comments=none --outfile="/tmp/min-$f"; \
        cat "/tmp/banner-$f" "/tmp/min-$f" > "theme/$f"; \
        node --check "theme/$f" || exit 1; \
        printf '%-18s %s\n' "$f" "$(wc -c < "theme/$f") bytes"; \
      done; \
    else echo "NH_MINIFY=false - shipping readable sources"; fi

# --- stage 2: hardened runtime ---------------------------------------
FROM nginx:1.27.4-alpine

# Theme payload, served at /_nh/ and inlined into HTML via SSI
COPY --from=themebuild /src/theme/ /usr/share/nginx/nh-theme/

# Config template processed by the image's built-in envsubst step
COPY default.conf.template /etc/nginx/templates/default.conf.template

# Ratings API (njs)
COPY njs/nh-ratings.js /etc/nginx/njs/nh-ratings.js
RUN sed -i '1i load_module modules/ngx_http_js_module.so;' /etc/nginx/nginx.conf

# Env-validation guard (05- prefix)
COPY docker-entrypoint.sh /docker-entrypoint.d/05-check-env.sh
RUN chmod +x /docker-entrypoint.d/05-check-env.sh && \
    mkdir -p /data/nh && \
    chown -R nginx:nginx /data/nh /usr/share/nginx/nh-theme

# Restrict substitution to OUR vars so nginx's own $host/$http_upgrade survive.
ENV NGINX_ENVSUBST_FILTER="^(ABS_UPSTREAM|THEME_VERSION|NH_[A-Z0-9_]+)$" \
    THEME_VERSION="secure-1.0.0"

# --- Default appearance
ENV NH_APP_NAME="" \
    NH_SHOW_LOGO_TEXT="true" \
    NH_COLORIZE_LOGO="false" \
    NH_LOGO_URL="" \
    NH_ACCENT_COLOR="#e0c27a" \
    NH_BASE_THEME="warm" \
    NH_MAIN_FONT="system-ui" \
    NH_FONT_SCALE="1.0" \
    NH_CAROUSEL_TIMING="15" \
    NH_SHOW_RECENT_SERIES="true" \
    NH_RECENT_SERIES_COUNT="12" \
    NH_CUSTOM_SERIES_CARDS="true" \
    NH_SHOW_HERO_CAROUSEL="true" \
    NH_SHOW_RATINGS="true" \
    NH_GLOBAL_SEARCH="true" \
    NH_PROXY_BUFFER_SIZE="16k" \
    NH_FOUC_BG="#181512" \
    NH_PUBLIC_MODE="false" \
    NH_GUEST_USERNAME="guest" \
    NH_GUEST_PASSWORD=""

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/_nh/core.js >/dev/null 2>&1 || exit 1
