#!/bin/bash -l 
#===============================================================================
#
#          FILE: apply.sh
# 
#         USAGE: ./apply.sh 
# 
#   DESCRIPTION: 
# 
#       OPTIONS: ---
#  REQUIREMENTS: ---
#          BUGS: ---
#         NOTES: ---
#        AUTHOR: Kirk Roybal (), Kirk.Roybal@gmail.com
#  ORGANIZATION: 
#       CREATED: 08/11/2026 09:46:03 AM
#      REVISION:  ---
#===============================================================================

set -o nounset                              # Treat unset variables as an error

zipfile=$(ls -1 *.zip 2> /dev/null)
# [[ ! -f "$zipfile" ]] && { echo "Can't find a patch zip file."; exit 1; }
echo "$zipfile"
[[ -f "$zipfile" ]] && { mv "$zipfile" patches/; unzip "patches/$zipfile"; }
patchfile=$(ls -1 *.patch)
echo "$patchfile"
[[ -f "$patchfile" ]] && { patch -p1 < "$patchfile"; rm $patchfile; }
fixfile=$(ls -1 fix-* 2>/dev/null)
echo "$fixfile"
[[ -f "$fixfile" ]] || exit
chmod +x "$fixfile"
"./$fixfile"
mv "$fixfile" patches/
