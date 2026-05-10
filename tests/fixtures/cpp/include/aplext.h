#ifndef APL_EXT_H
#define APL_EXT_H
namespace apl {
class Engine {
public:
    virtual ~Engine() = default;
    virtual int run(int x) { return x; }
    virtual void stop() {}
};
int compute(int a, int b);
}
#endif
