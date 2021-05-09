#!/usr/bin/env bash

readonly PROGNAME=$(basename $0)
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"

# Usage string
usage="
Usage:
  ${PROGNAME} -h|--help

Options:
  -h --help             Show this help text
  -s --source   <path>  Select source directory
  -p --partials <path>  Specify partials directory
  -c --config   <path>  Specify config file
  -t --target   <path>  Set the output directory
"

# Declare storage
src=src
target=docs
renderargs=

# Parse arguments
while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help)
      echo "$usage"
      exit 0
      ;;
    -s|--source)
      shift
      [[ -d "${1}" ]] || {
        echo "Directory '${1}' not found"
        exit 1
      }
      src="${1}"
      ;;
    -t|--target)
      shift
      [[ -d "${1}" ]] || {
        echo "Directory '${1}' not found"
        exit 1
      }
      target="${1}"
      ;;
    -c|--config)
      shift
      renderargs="${renderargs} -c ${1}"
      ;;
    -p|--partials)
      shift
      renderargs="${renderargs} -p ${1}"
      ;;
    *)
      echo "Unknown argument: $1"
      exit 1
      ;;
  esac
  shift
done

while IFS=':' read name filename; do
  dst=${name%%.hbs}
  if [[ "${dst}" == "index" ]]; then dst=""; fi
  mkdir -p "${target}/${dst}"
  ${DIR}/template.sh ${renderargs} "${filename}" > "${target}/${dst}/index.html"
done <<< "$(find "${src}" -type f -printf "%P:%p\n")"
