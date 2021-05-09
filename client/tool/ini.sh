#!/usr/bin/env bash
# c90839f9-835f-4f11-b6cd-86d17220195d
shopt -s extglob

readonly PROGNAME=$(basename $0)
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"

# Usage string
usage="
Usage:
  ${PROGNAME} ini-file [token]
"

# No file = no data
inifile="${1}"
if [[ ! -f "$inifile" ]]; then
  exit
fi

# Process the file line-by-line
SECTION=
while read line; do

  # Remove surrounding whitespace
  line=${line##*( )} # From the beginning
  line=${line%%*( )} # From the end

  # Remove comments and empty lines
  if [[ "${line:0:1}" == ';' ]] || [[ "${#line}" == 0 ]]; then
    continue
  fi

  # Handle section markers
  if [[ "${line:0:1}" == "[" ]]; then
    SECTION=$(echo $line | sed -e 's/\[\(.*\)\]/\1/')
    SECTION=${SECTION##*( )}
    SECTION=${SECTION%%*( )}
    SECTION="${SECTION}."
    continue
  fi

  # Output found variable
  NAME=${line%%=*}
  NAME=${NAME%%*( )}
  VALUE=${line##*=}
  VALUE=${VALUE##*( )}

  # Output searched or all
  if [[ -z "${2}" ]]; then
    echo "${SECTION}${NAME}=${VALUE}"
  fi
  if [[ "${SECTION}${NAME}" = "${2}" ]]; then
    echo "${VALUE}"
  fi

done < "${inifile}"
