#ifndef APL_IN_H
#define APL_IN_H
#include "aplext.h"
namespace apl {
class FastEngine : public Engine {
public:
    int run(int x) override { return x * 2; }
    void stop() override {}
};
int compute_internal(int a);
}
#endif
