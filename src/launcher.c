#import <Foundation/Foundation.h>
#include <mach-o/dyld.h>
#include <unistd.h>
#include <pwd.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <limits.h>
int main(int argc,char **argv){
 @autoreleasepool {
 char exe[PATH_MAX],engine[PATH_MAX],profile[PATH_MAX+64];uint32_t size=sizeof exe;
 if(_NSGetExecutablePath(exe,&size)!=0)return 111;
 char *slash=strrchr(exe,'/');if(!slash)return 112;*slash=0;
 snprintf(engine,sizeof engine,"%s/ChatGPT",exe);
 const char *home=getenv("HOME");if(!home)home=getpwuid(getuid())->pw_dir;
 NSString *root=[[NSString stringWithUTF8String:home] stringByAppendingPathComponent:@"Library/Application Support/OpenCodex"];
 NSData *data=[NSData dataWithContentsOfFile:[root stringByAppendingPathComponent:@"opencodex.json"]];
 id settings=data?[NSJSONSerialization JSONObjectWithData:data options:0 error:NULL]:nil;
 BOOL claude=[settings isKindOfClass:[NSDictionary class]]&&[settings[@"mode"] isEqual:@"ssh"]&&[settings[@"sshAgent"] isEqual:@"claude"];
 NSString *userData=claude?[root stringByAppendingPathComponent:@"native-claude-ui"]:root;
 snprintf(profile,sizeof profile,"--user-data-dir=%s",userData.fileSystemRepresentation);
 char **args=calloc((size_t)argc+3,sizeof(char*));if(!args)return 114;args[0]=engine;args[1]=profile;
 int j=2;for(int i=1;i<argc;i++)if(strncmp(argv[i],"--user-data-dir",15)!=0)args[j++]=argv[i];
 args[j]=NULL;execv(engine,args);perror("OpenCodex");return 113;
 }
}
