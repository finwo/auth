#!/usr/bin/env bash
# e660cc6c-638a-4f9b-9527-ff96a19bbeed

# Very simple templating system that replaces {{VAR}} by the value of $VAR.
# Supports default values by writting {{VAR=value}} in the template.

# Replaces all {{VAR}} by the $VAR value in a template file and outputs it

readonly PROGNAME=$(basename $0)
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"

# Usage string
usage="
Usage:
  ${PROGNAME} -h|--help
  ${PROGNAME} --update
  ${PROGNAME} [-c|--config config_file] [-p|--partials partials_dir] template_file [...template_file]

Options:
  -h --help             Show this help text
     --update           Perform a self-update
  -c --config <path>    Specify config file
  -p --partials <path>  Specify partials directory
"

# Declare storage
declare -A TOKENS
declare -A TEMPLATES
declare -A PARTIALS
PARTIALARGS=
INDEX=0

# Parse arguments
while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help)
      echo "$usage"
      exit 0
      ;;
    --update)
      curl -L -H 'Cache-Control: no-cache' https://raw.githubusercontent.com/finwo/ini-tools/master/template.sh > "${DIR}/${PROGNAME}"
      exit $?
      ;;
    -c|--config)
      shift
      PARTIALARGS="${PARTIALARGS} -c ${1}"
      if [[ -f "${1}" ]]; then
        while IFS='=' read key value; do
          if [ -z "$key" ]; then continue; fi
          TOKENS["$key"]="$value"
        done <<< "$(${DIR}/ini.sh ${1})"
      fi
      ;;
    -p|--partials)
      shift
      PARTIALARGS="${PARTIALARGS} -p ${1}"
      if [[ -d "${1}" ]]; then
        while IFS=':' read name filename; do
          PARTIALS["$name"]="${filename}"
        done <<< "$(find "${1}" -type f -printf "%P:%p\n")"
      fi
      ;;
    *)
      if [[ -f "${1}" ]]; then
        TEMPLATES[$INDEX]="${1}"
        INDEX=$(( $INDEX + 1 ))
      fi
      ;;
  esac
  shift
done

# Cancel if we have no config files
if [ "${INDEX}" -eq 0 ]; then
  echo "ERROR: You need to specify a template file" >&2
  echo "$usage"
  exit 1
fi

# Handle all given templates
for templatefile in "${TEMPLATES[@]}"; do
  CONTENT=$(cat $templatefile);

  # Replace tokens
  for token in "${!TOKENS[@]}"; do
    CONTENT=${CONTENT//"{{$token}}"/"${TOKENS[$token]}"}
  done

  # Handle partials
  for partial in "${!PARTIALS[@]}"; do
    if [[ "${CONTENT}" == *"{{>${partial}}}"* ]]; then
      PARTIALCONTENT="$(${DIR}/${PROGNAME} ${PARTIALARGS} ${PARTIALS[$partial]})"
      CONTENT=${CONTENT//"{{>$partial}}"/"${PARTIALCONTENT}"}
    fi
  done

  # Output the result
  echo -e "$CONTENT"
done


