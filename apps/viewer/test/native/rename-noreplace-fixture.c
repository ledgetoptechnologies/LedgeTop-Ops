/* Linux fixture only: source pathname is UNTRUSTED. No runtime or cleanup authority. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/fs.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

static int component(const char *s) { return s && *s && strcmp(s,".") && strcmp(s,"..") && !strchr(s,'/'); }
/* Return 0 success, 1 destination already exists, 2 uncertain/error.
 * A successful return does NOT attest the identity of the moved source. */
static int promote(int parent, const char *src, const char *dst) {
  if (!component(src) || !component(dst)) return 2;
  if (syscall(SYS_renameat2,parent,src,parent,dst,RENAME_NOREPLACE) != 0)
    return errno == EEXIST || errno == ENOTEMPTY ? 1 : 2;
  return fsync(parent) == 0 ? 0 : 2;
}
static void require(int ok,const char *msg) { if (!ok) { perror(msg); exit(1); } }
static ino_t inode_at(int fd,const char *name) { struct stat s;require(fstatat(fd,name,&s,AT_SYMLINK_NOFOLLOW)==0,name);return s.st_ino; }
int main(int argc,char **argv) {
  require(argc==2,"fixture path");int fd=open(argv[1],O_RDONLY|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW);require(fd>=0,"fixture dir");
  require(mkdirat(fd,"source",0700)==0,"mkdir source");require(mkdirat(fd,"destination",0700)==0,"mkdir destination");ino_t src=inode_at(fd,"source"),dest=inode_at(fd,"destination");
  require(promote(fd,"source","destination")==1,"preexisting destination must win");require(inode_at(fd,"source")==src && inode_at(fd,"destination")==dest,"no replacement");
  /* Competing process publishes an empty destination before promotion. */
  require(mkdirat(fd,"race-source",0700)==0,"race source");int ready[2];require(pipe(ready)==0,"pipe");pid_t child=fork();require(child>=0,"fork");
  if(child==0){close(ready[0]);if(mkdirat(fd,"race-destination",0700)!=0 || write(ready[1],"x",1)!=1)_exit(1);_exit(0);}
  close(ready[1]);char signal;require(read(ready[0],&signal,1)==1,"competitor ready");close(ready[0]);int status;require(waitpid(child,&status,0)==child && WIFEXITED(status) && WEXITSTATUS(status)==0,"competitor exit");ino_t competitor=inode_at(fd,"race-destination");require(promote(fd,"race-source","race-destination")==1,"competing destination");require(inode_at(fd,"race-destination")==competitor,"competitor untouched");
  require(mkdirat(fd,"move",0700)==0,"mkdir move");ino_t original=inode_at(fd,"move");require(promote(fd,"move","result")==0,"promotion");require(inode_at(fd,"result")==original,"fixture success inode");
  /* Deterministic source substitution after a hypothetical validation. */
  require(mkdirat(fd,"checked",0700)==0,"mkdir checked");ino_t checked=inode_at(fd,"checked");require(renameat(fd,"checked",fd,"displaced")==0,"displace");require(mkdirat(fd,"checked",0700)==0,"replacement");ino_t replaced=inode_at(fd,"checked");require(replaced!=checked,"different inode");require(promote(fd,"checked","moved-replacement")==0,"replacement promoted");require(inode_at(fd,"moved-replacement")==replaced && inode_at(fd,"displaced")==checked,"source substitution demonstrated");
  require(promote(fd,"../bad","x")==2,"component validation");require(close(fd)==0,"close");puts("fixture passed; source pathname remains untrusted");return 0;
}
