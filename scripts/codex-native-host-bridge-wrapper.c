#include <errno.h>
#include <libgen.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
  char resolved[PATH_MAX];
  if (realpath(argv[0], resolved) == NULL) {
    fprintf(stderr, "failed to resolve wrapper path: %s\n", strerror(errno));
    return 1;
  }

  char dirbuf[PATH_MAX];
  if (strlcpy(dirbuf, resolved, sizeof(dirbuf)) >= sizeof(dirbuf)) {
    fprintf(stderr, "wrapper path is too long\n");
    return 1;
  }

  char *dir = dirname(dirbuf);
  char script[PATH_MAX];
  if (snprintf(script, sizeof(script), "%s/codex-native-host-bridge.mjs", dir) >=
      (int)sizeof(script)) {
    fprintf(stderr, "script path is too long\n");
    return 1;
  }

  const char *node =
      "/Applications/Codex.app/Contents/Resources/cua_node/bin/node";
  if (access(node, X_OK) != 0) {
    node = "/usr/bin/env";
  }

  int extra = (strcmp(node, "/usr/bin/env") == 0) ? 1 : 0;
  char **child_argv = calloc((size_t)argc + 3 + (size_t)extra, sizeof(char *));
  if (child_argv == NULL) {
    fprintf(stderr, "failed to allocate argv\n");
    return 1;
  }

  int index = 0;
  child_argv[index++] = (char *)node;
  if (extra) {
    child_argv[index++] = "node";
  }
  child_argv[index++] = script;
  for (int i = 1; i < argc; i++) {
    child_argv[index++] = argv[i];
  }
  child_argv[index] = NULL;

  execv(node, child_argv);
  fprintf(stderr, "failed to exec bridge: %s\n", strerror(errno));
  return 1;
}
