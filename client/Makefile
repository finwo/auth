.PHONY: docs
docs:
	mkdir -p docs
	tool/build-pages.sh --source src/pages --partials src/partial --target docs
	# "build": "esbuild public/_init.js --bundle --outfile=public/init.js",
	# Build rdf data
	# rm -rf docs/rdf
	# cp -r rdf docs/
	# # Fetch specifications
	# rm -rf lib/finwo/specifications
	# mkdir -p lib/finwo/specifications
	# curl -L https://github.com/finwo/specifications/tarball/master | tar zx --strip-components=1 -C lib/finwo/specifications
	# # Build nav partial
	# tool/template.sh -c config.ini -p partials partials/core/nav.head.hbs >  partials/core/nav.hbs
	# find pages -mindepth 1 -maxdepth 1 -type d | sort | xargs -n 1 tool/build-page-nav.sh
	# tool/template.sh -c config.ini -p partials partials/core/nav.tail.hbs >> partials/core/nav.hbs
	# # Build extra pages
	# find pages -mindepth 1 -maxdepth 1 -type d | sort | xargs -n 1 tool/build-page.sh
	# # Build blog
	# tool/template.sh -c config.ini -p partials partials/index.head.hbs > docs/index.html
	# tool/template.sh -c config.ini -p partials partials/rss.head.hbs   > docs/rss.xml
	# find posts -mindepth 1 -maxdepth 1 -type d | sort -r | xargs -n 1 -I@ tool/build-page.sh @ partials/index.item.hbs docs/index.html partials/rss.item.hbs docs/rss.xml
	# tool/template.sh -c config.ini -p partials partials/index.tail.hbs >> docs/index.html
	# tool/template.sh -c config.ini -p partials partials/rss.tail.hbs   >> docs/rss.xml
	# # Copy static assets
	# cp -r assets docs/

.PHONY: dev
dev:
	concurrently \
		"nodemon --ext css,hbs,js,json,md --exec 'bash -c' --delay 1 --verbose --watch src make" \
		"browser-sync start --server docs/ --files docs/"
